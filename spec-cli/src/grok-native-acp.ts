import type { Readable, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'

type RpcObject = Record<string, unknown>
type Request = { sessionId: string; promptId: string; cwd: string; prompt: string; schema: unknown; model?: string }
type Identity = { sessionId: string; requestId: string; cwd: string }
export type GrokAcpTerminal = Identity & (
  | { kind: 'result'; stopReason: string; models: string[]; text: string; structuredOutput?: unknown }
  | { kind: 'rate_limited'; rpcCode: -32003; message: 'Rate limited' }
  | { kind: 'prompt_error' }
)

export class GrokAcpProtocolError extends Error {
  constructor(message: string, readonly code: 'invalid_protocol' | 'missing_terminal' | 'transport_error' = 'invalid_protocol') {
    super(message)
  }
}

const requestIds = { initialize: 1, authenticate: 2, 'session/new': 3, 'session/prompt': 4 } as const
const stopReasons = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])
const object = (value: unknown): RpcObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RpcObject : undefined

async function* frames(stdout: Readable): AsyncGenerator<RpcObject> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const pieces: string[] = []
  try {
    for await (const chunk of stdout.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      const lines = decoder.decode(chunk, { stream: true }).split('\n')
      for (const line of lines.slice(0, -1)) {
        pieces.push(line)
        const packet = object(JSON.parse(pieces.join('')))
        pieces.length = 0
        if (packet?.jsonrpc !== '2.0') throw new GrokAcpProtocolError('Grok ACP stream has an invalid JSON-RPC envelope')
        yield packet
      }
      const tail = lines.at(-1)!
      if (tail) pieces.push(tail)
    }
    if (decoder.decode() || pieces.length) throw new GrokAcpProtocolError('Grok ACP stream has an incomplete frame')
  } catch (error) {
    if (error instanceof GrokAcpProtocolError) throw error
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new GrokAcpProtocolError('Grok ACP stream has an invalid JSON frame')
    throw new GrokAcpProtocolError('Grok ACP stdout could not be read', 'transport_error')
  }
}

function promptResult(result: RpcObject, identity: Identity, chunks: string[]): GrokAcpTerminal {
  const meta = object(result._meta)
  const stopReason = result.stopReason
  if (meta?.sessionId !== identity.sessionId || meta.requestId !== identity.requestId ||
    meta.promptId !== undefined && meta.promptId !== identity.requestId ||
    typeof stopReason !== 'string' || !stopReasons.has(stopReason))
    throw new GrokAcpProtocolError('Grok ACP terminal differs from its original session or prompt')
  const usage = object(meta.usage)
  const modelUsage = object(usage?.modelUsage)
  const modelEntries = Object.entries(modelUsage ?? {})
  if (meta.usage !== undefined && !usage || usage?.modelUsage !== undefined && !modelUsage ||
    stopReason === 'end_turn' && !modelEntries.length || modelEntries.some(([model, value]) => !/^[a-z\d][a-z\d._:/-]*$/i.test(model) || !object(value)))
    throw new GrokAcpProtocolError('Grok ACP terminal lacks valid actual model usage')
  const hasStructuredOutput = Object.hasOwn(meta, 'structuredOutput')
  return {
    ...identity, kind: 'result', stopReason, models: modelEntries.map(([model]) => model), text: hasStructuredOutput ? '' : chunks.join(''),
    ...(hasStructuredOutput ? { structuredOutput: meta.structuredOutput } : {}),
  }
}

export async function observeGrokNativeAcp(stdout: Readable, stdin: Writable, request: Request, onTerminal: (terminal: GrokAcpTerminal) => void): Promise<GrokAcpTerminal> {
  const { sessionId, promptId, cwd, prompt, schema, model } = request
  const identity = { sessionId, requestId: promptId, cwd }
  const chunks: string[] = []
  let terminal: GrokAcpTerminal | undefined
  let awaiting: keyof typeof requestIds = 'initialize'
  const send = (packet: RpcObject): Promise<void> => new Promise((resolve, reject) => {
    stdin.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n', error => {
      if (error) reject(new GrokAcpProtocolError('Grok ACP stdin could not be written', 'transport_error'))
      else resolve()
    })
  })
  const sendRequest = (method: keyof typeof requestIds, params: RpcObject): Promise<void> => send({ id: requestIds[method], method, params })
  const inputClosed = finished(stdin, { readable: false, cleanup: true }).then(() => true, () => false)
  await sendRequest('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  for await (const packet of frames(stdout)) {
    if (terminal) throw new GrokAcpProtocolError('Grok ACP stream has data after its original prompt terminal')
    const { method, id } = packet
    const params = object(packet.params)
    const hasResult = Object.hasOwn(packet, 'result'), hasError = Object.hasOwn(packet, 'error')
    if (Object.hasOwn(packet, 'method')) {
      if (typeof method !== 'string' || !method || hasResult || hasError || Object.hasOwn(packet, 'params') && !params)
        throw new GrokAcpProtocolError('Grok ACP agent sent an invalid request or notification')
      if (Object.hasOwn(packet, 'id')) {
        if (method === 'session/update' || typeof id !== 'string' && !Number.isSafeInteger(id))
          throw new GrokAcpProtocolError('Grok ACP agent sent an invalid request ID')
        if (method === 'session/request_permission') {
          if (awaiting !== 'session/prompt' || params?.sessionId !== sessionId)
            throw new GrokAcpProtocolError('Grok ACP permission request differs from its original session')
          await send({ id, result: { outcome: { outcome: 'cancelled' } } })
        } else await send({ id, error: { code: -32601, message: 'Client method unavailable' } })
      } else if (method === 'session/update') {
        const update = object(params?.update), updateMeta = object(params?._meta)
        const kind = update?.sessionUpdate
        if (params?.sessionId !== sessionId || typeof kind !== 'string' || !kind ||
          params?._meta !== undefined && !updateMeta || updateMeta?.promptId !== undefined && updateMeta.promptId !== promptId ||
          awaiting !== 'session/prompt' && (awaiting !== 'session/new' || kind !== 'available_commands_update'))
          throw new GrokAcpProtocolError('Grok ACP update differs from its original session or prompt')
        if (kind === 'tool_call' || kind === 'tool_call_update') chunks.length = 0
        if (kind === 'agent_message_chunk') {
          const content = object(update?.content)
          if (typeof content?.type !== 'string' || content.type === 'text' && typeof content.text !== 'string')
            throw new GrokAcpProtocolError('Grok ACP agent sent an invalid assistant message chunk')
          if (content.type === 'text') chunks.push(content.text as string)
        }
      } else if (!method.startsWith('_x.ai/') || params?.sessionId != null && params.sessionId !== sessionId) {
        throw new GrokAcpProtocolError('Grok ACP agent sent an unexpected notification')
      }
      continue
    }
    if (id !== requestIds[awaiting] || hasResult === hasError || Object.hasOwn(packet, 'params'))
      throw new GrokAcpProtocolError('Grok ACP response differs from its outstanding request')
    if (hasError) {
      const error = object(packet.error)
      if (!Number.isSafeInteger(error?.code) || typeof error?.message !== 'string')
        throw new GrokAcpProtocolError('Grok ACP agent returned an invalid RPC error')
      if (awaiting !== 'session/prompt') throw new GrokAcpProtocolError(`Grok ACP ${awaiting} was rejected`)
      terminal = error.code === -32003 && error.message === 'Rate limited'
        ? { ...identity, kind: 'rate_limited', rpcCode: -32003, message: 'Rate limited' }
        : { ...identity, kind: 'prompt_error' }
    } else {
      const result = object(packet.result)
      if (!result) throw new GrokAcpProtocolError('Grok ACP agent returned an invalid RPC result')
      if (awaiting === 'initialize') {
        const offered = Array.isArray(result.authMethods) ? result.authMethods.map(method => object(method)?.id) : []
        const methodId = ['cached_token', 'xai.api_key'].find(method => offered.includes(method))
        if (result.protocolVersion !== 1 || !methodId)
          throw new GrokAcpProtocolError('Grok ACP agent did not advertise protocol v1 with local noninteractive authentication')
        awaiting = 'authenticate'
        await sendRequest(awaiting, { methodId, _meta: { headless: true } })
      } else if (awaiting === 'authenticate') {
        awaiting = 'session/new'
        await sendRequest(awaiting, { cwd, mcpServers: [], _meta: { sessionId, ...(model === undefined ? {} : { modelId: model }) } })
      } else if (awaiting === 'session/new') {
        if (result.sessionId !== sessionId || object(result._meta)?.currentWorkingDirectory !== cwd)
          throw new GrokAcpProtocolError('Grok ACP opened a different session or worktree')
        awaiting = 'session/prompt'
        await sendRequest(awaiting, { sessionId, prompt: [{ type: 'text', text: prompt }], _meta: { promptId, outputSchema: schema } })
      } else terminal = promptResult(result, identity, chunks)
    }
    if (terminal) {
      stdin.end()
      onTerminal(terminal)
    }
  }
  if (!terminal) throw new GrokAcpProtocolError('Grok ACP stream closed without its original terminal', 'missing_terminal')
  if (!stdout.readableEnded || !await inputClosed) throw new GrokAcpProtocolError('Grok ACP transport did not finish cleanly', 'transport_error')
  return terminal
}
