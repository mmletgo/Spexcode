export const managedVendors = ['grok', 'claude', 'zcode', 'cursor', 'codex'] as const
export type ManagedVendor = typeof managedVendors[number]
export const managedFrozenCapability = 'frozen-reader-v2' as const
export type ManagedFrozenReader = {
  capability: typeof managedFrozenCapability
  protocol: 'codex-persistent-v2'
  model: string
  cliVersion: string
  cliSha256: string
}
export type ManagedRoute = {
  routeId: string
  vendor: ManagedVendor
  model: string
  kind: 'cli' | 'anthropic-messages'
  frozenReader?: ManagedFrozenReader
}

const namespace = '@spex-llm-manager-v1/'
const vendorSet = new Set<string>(managedVendors)

const validName = (value: unknown): value is string => typeof value === 'string' && !!value && value === value.trim() && !/[\r\n\0]/u.test(value)

export function readManagedRoute(value: unknown): ManagedRoute {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== ('frozenReader' in value ? 5 : 4)
    || !('routeId' in value) || typeof value.routeId !== 'string' || !/^[0-9a-f]{64}$/u.test(value.routeId)
    || !('vendor' in value) || typeof value.vendor !== 'string' || !vendorSet.has(value.vendor)
    || !('model' in value) || !validName(value.model)
    || !('kind' in value) || (value.kind !== 'cli' && (value.kind !== 'anthropic-messages' || value.vendor !== 'claude'))) {
    throw new Error('Invalid LLM Manager route identity')
  }
  const frozen = 'frozenReader' in value ? value.frozenReader : undefined
  if ('frozenReader' in value && (!frozen || typeof frozen !== 'object' || Object.keys(frozen).length !== 5
    || !('capability' in frozen) || frozen.capability !== managedFrozenCapability || !('protocol' in frozen) || frozen.protocol !== 'codex-persistent-v2'
    || value.vendor !== 'codex' || value.kind !== 'cli' || !('model' in frozen) || !validName(frozen.model) || frozen.model !== value.model
    || !('cliVersion' in frozen) || !validName(frozen.cliVersion)
    || !('cliSha256' in frozen) || typeof frozen.cliSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(frozen.cliSha256)))
    throw new Error('Invalid LLM Manager frozen reader identity')
  const reader = frozen as ManagedFrozenReader | undefined
  const frozenReader = reader && { capability: reader.capability, protocol: reader.protocol, model: reader.model, cliVersion: reader.cliVersion, cliSha256: reader.cliSha256 }
  return { routeId: value.routeId, vendor: value.vendor as ManagedVendor, model: value.model, kind: value.kind, ...(frozenReader ? { frozenReader } : {}) }
}

/** 路线标识只绑定 Manager 归属与公开模型，原生厂商前缀继续控制派发。 */
export function managedModel(route: ManagedRoute): string {
  return `${route.vendor}:${namespace}${Buffer.from(JSON.stringify(readManagedRoute(route))).toString('base64url')}`
}

export function managedRoute(model: string | undefined): ManagedRoute | undefined {
  const separator = model?.indexOf(':') ?? -1
  if (!model || separator < 0 || !model.slice(separator + 1).startsWith(namespace)) return undefined
  const value = model.slice(separator + 1 + namespace.length)
  if (!value || !/^[a-zA-Z0-9_-]+$/u.test(value)) throw new Error('Invalid LLM Manager model binding')
  const route = readManagedRoute(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  if (managedModel(route) !== model) throw new Error('Invalid LLM Manager model binding')
  return route
}

export function nativeModelValue(model: string | undefined, vendor: ManagedVendor): string {
  if (!model?.startsWith(`${vendor}:`)) return ''
  return managedRoute(model)?.model ?? model.slice(vendor.length + 1)
}
