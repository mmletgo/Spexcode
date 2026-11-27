var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/llm_manager/native/cli-probe.mjs
import { spawnSync } from "node:child_process";
function runNativeCliProbe(launch, flags) {
  return spawnSync(launch.command, [...launch.args, ...flags], {
    cwd: launch.cwd,
    env: launch.env,
    encoding: "utf8",
    timeout: 1e4
  });
}
var init_cli_probe = __esm({
  "src/llm_manager/native/cli-probe.mjs"() {
  }
});

// src/llm_manager/native/claude.mjs
var claude_exports = {};
__export(claude_exports, {
  CLAUDE_LEGACY_CLI_VERSION: () => CLAUDE_LEGACY_CLI_VERSION,
  CLAUDE_VERSION_ARGS: () => CLAUDE_VERSION_ARGS,
  ClaudeNativeProtocolError: () => ClaudeNativeProtocolError,
  assertClaudeLegacyConfiguration: () => assertClaudeLegacyConfiguration,
  checkClaudeHistoryChain: () => checkClaudeHistoryChain,
  claudeApiMessageBlobs: () => claudeApiMessageBlobs,
  claudeApiRequestHashes: () => claudeApiRequestHashes,
  claudeApiSourceDigest: () => claudeApiSourceDigest,
  claudeApiToolResultIds: () => claudeApiToolResultIds,
  claudeAuthenticationArgs: () => claudeAuthenticationArgs,
  claudeMcpToolNames: () => claudeMcpToolNames,
  claudeMessageBlocks: () => claudeMessageBlocks,
  claudeMessageDigest: () => claudeMessageDigest,
  claudeNativeModel: () => claudeNativeModel,
  claudeOriginalReplayMismatch: () => claudeOriginalReplayMismatch,
  claudeOutputLimitCompanions: () => claudeOutputLimitCompanions,
  claudeProcessEnvironment: () => claudeProcessEnvironment,
  claudeProtocolObservation: () => claudeProtocolObservation,
  claudeRecoveryCompanion: () => claudeRecoveryCompanion,
  claudeSchemaRetryDiagnostics: () => claudeSchemaRetryDiagnostics,
  claudeStructuredArgs: () => claudeStructuredArgs,
  claudeStructuredOutputError: () => claudeStructuredOutputError,
  claudeTerminalMatchesIdentity: () => claudeTerminalMatchesIdentity,
  claudeWorktreeArgs: () => claudeWorktreeArgs,
  claudeWorktreeTerminal: () => claudeWorktreeTerminal,
  consumeClaudeRecoveryRequest: () => consumeClaudeRecoveryRequest,
  encodeClaudeInterrupt: () => encodeClaudeInterrupt,
  encodeClaudeUserMessage: () => encodeClaudeUserMessage,
  inspectClaudeCliVersion: () => inspectClaudeCliVersion,
  inspectClaudeIsolatedAuthentication: () => inspectClaudeIsolatedAuthentication,
  interpretClaudeAuthenticationStatus: () => interpretClaudeAuthenticationStatus,
  interpretClaudeStreamEvent: () => interpretClaudeStreamEvent,
  isClaudeRateLimitTerminal: () => isClaudeRateLimitTerminal,
  isClaudeRecoveryMessageDigest: () => isClaudeRecoveryMessageDigest,
  isClaudeStructuredOutputEnforcement: () => isClaudeStructuredOutputEnforcement,
  matchingClaudeRecoveries: () => matchingClaudeRecoveries,
  prepareClaudeAuthenticationEnvironment: () => prepareClaudeAuthenticationEnvironment,
  projectClaudeApiSourceMetadata: () => projectClaudeApiSourceMetadata,
  projectClaudeFrozenReadEvidence: () => projectClaudeFrozenReadEvidence,
  projectClaudeFrozenSchemaFailure: () => projectClaudeFrozenSchemaFailure,
  projectClaudePublicHistory: () => projectClaudePublicHistory,
  projectClaudeReplayApiSourceMetadata: () => projectClaudeReplayApiSourceMetadata,
  projectClaudeReplayHistory: () => projectClaudeReplayHistory,
  projectClaudeWorktreeSchemaFailure: () => projectClaudeWorktreeSchemaFailure,
  readClaudeStreamEvent: () => readClaudeStreamEvent,
  recordClaudeRecoveryRequest: () => recordClaudeRecoveryRequest
});
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function inspectClaudeCliVersion(launch, nativeConfiguration) {
  const cliVersion = execFileSync(launch.command, [...launch.args, ...CLAUDE_VERSION_ARGS], { encoding: "utf8" }).trim();
  if (!cliVersion || !nativeConfiguration && cliVersion !== CLAUDE_LEGACY_CLI_VERSION) {
    throw new ClaudeNativeProtocolError("unsupported", "Claude CLI version has no verified isolated capability identity");
  }
  return cliVersion;
}
function assertClaudeLegacyConfiguration(environment) {
  if (["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some((key) => environment[key])) {
    throw new ClaudeNativeProtocolError("unsupported", "Claude third-party provider isolation has not been verified");
  }
  for (const name of ["CLAUDE.md", "managed-settings.json", "managed-mcp.json"]) {
    if (existsSync(join("/Library/Application Support/ClaudeCode", name))) {
      throw new ClaudeNativeProtocolError("unsupported", "Claude managed policy isolation needs separate capability evidence");
    }
  }
}
function prepareClaudeAuthenticationEnvironment(environment, settingsPath = join(homedir(), ".claude", "settings.json")) {
  const explicit = authenticationKeys.filter((key) => Object.hasOwn(environment, key));
  if (explicit.length) {
    return { environment: Object.fromEntries(explicit.map((key) => [key, environment[key]])), source: "process" };
  }
  if (!existsSync(settingsPath)) return { environment: {}, source: "cli" };
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    throw new ClaudeNativeProtocolError("unsupported", "Claude native user authentication settings could not be parsed safely");
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || settings.env !== void 0 && (settings.env === null || typeof settings.env !== "object" || Array.isArray(settings.env))) {
    throw new ClaudeNativeProtocolError("unsupported", "Claude native user authentication settings have an invalid shape");
  }
  const selected = {};
  for (const key of authenticationKeys) {
    if (!settings.env || !Object.hasOwn(settings.env, key)) continue;
    const value = settings.env[key];
    if (typeof value !== "string") throw new ClaudeNativeProtocolError("unsupported", "Claude native user authentication setting must be a string");
    selected[key] = value;
  }
  return { environment: selected, source: Object.keys(selected).length ? "native-user-settings" : "cli" };
}
function claudeProcessEnvironment(input) {
  const directories = { TMPDIR: input.tmpDir, CLAUDE_CODE_TMPDIR: input.tmpDir, CLAUDE_CODE_DEBUG_LOGS_DIR: input.debugDir };
  if (input.nativeConfiguration) {
    const environment = { ...input.environment, ...directories };
    for (const key of input.stripEnvironment ?? []) delete environment[key];
    delete environment.CLAUDECODE;
    return { environment, source: "native" };
  }
  const authentication = prepareClaudeAuthenticationEnvironment(input.environment, input.settingsPath);
  return {
    environment: {
      PATH: input.environment.PATH,
      HOME: homedir(),
      TMPDIR: directories.TMPDIR,
      CLAUDE_CONFIG_DIR: input.configHome,
      CLAUDE_CODE_TMPDIR: directories.CLAUDE_CODE_TMPDIR,
      CLAUDE_CODE_DEBUG_LOGS_DIR: directories.CLAUDE_CODE_DEBUG_LOGS_DIR,
      MAX_MCP_OUTPUT_TOKENS: "500000",
      ...authentication.environment
    },
    source: authentication.source
  };
}
function claudeAuthenticationArgs() {
  return [...isolatedSettings, "auth", "status", "--json"];
}
function interpretClaudeAuthenticationStatus(stdout, status) {
  let authentication;
  try {
    authentication = JSON.parse(stdout);
  } catch {
    throw new ClaudeNativeProtocolError("unsupported", `Claude isolated authentication returned invalid status (exit ${status ?? "signal"})`);
  }
  if (!["none", "claude.ai", "oauth_token", "api_key", "api_key_helper"].includes(authentication?.authMethod ?? "") || authentication.apiProvider !== "firstParty") {
    throw new ClaudeNativeProtocolError("unsupported", "Claude isolated authentication provider/status has no verified capability identity");
  }
  const { loggedIn, authMethod, apiProvider } = authentication;
  return { loggedIn, authMethod, apiProvider };
}
function inspectClaudeIsolatedAuthentication(launch) {
  const auth = runNativeCliProbe(launch, claudeAuthenticationArgs());
  if (auth.error) {
    throw new ClaudeNativeProtocolError("unsupported", `Claude isolated authentication status failed (${/** @type {NodeJS.ErrnoException} */
    auth.error.code ?? "unknown"})`);
  }
  const authentication = interpretClaudeAuthenticationStatus(auth.stdout, auth.status);
  const rejection = auth.status !== 0 || authentication.loggedIn !== true ? new ClaudeNativeProtocolError("unsupported", "The actual Claude CLI reports authentication unavailable in its isolated runtime; existing keychain/wrapper authentication is preserved and credentials are never copied") : void 0;
  return { authentication, exitStatus: auth.status, rejection };
}
function claudeNativeModel(model, nativeConfiguration, managedModel) {
  const requested = model ?? "";
  const hasClaudePrefix = requested.startsWith("claude:");
  const selected = hasClaudePrefix ? requested.slice(7) : "";
  if (nativeConfiguration === "cli-config-v1") {
    const value = hasClaudePrefix ? managedModel ?? selected : "";
    if (!value.trim() || value.includes("\0")) throw new ClaudeNativeProtocolError("unsupported", "Claude execution requires a nonempty claude:<native-model-selection>");
    return value;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(selected) || ["sonnet", "opus", "haiku", "fable", "default"].includes(selected.toLowerCase())) {
    throw new ClaudeNativeProtocolError("unsupported", "Claude execution requires claude:<exact-native-model-id>");
  }
  return selected;
}
function effortArgs(effort) {
  if (!effort) return [];
  if (!["low", "medium", "high", "xhigh"].includes(effort)) {
    throw new ClaudeNativeProtocolError("unsupported", "Claude effort must be an explicitly supported native value");
  }
  return ["--effort", effort];
}
function claudeStructuredArgs(input) {
  const effort = effortArgs(input.effort);
  return [
    "-p",
    "--session-id",
    input.sessionId,
    "--model",
    input.model,
    ...streamArgs,
    ...isolatedSettings,
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpConfig,
    "--tools",
    "",
    "--allowedTools",
    ...input.allowedTools,
    "--disallowedTools",
    "EndConversation",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--disable-slash-commands",
    "--no-chrome",
    "--system-prompt",
    input.systemPrompt,
    "--json-schema",
    JSON.stringify(input.schema),
    ...effort
  ];
}
function claudeWorktreeArgs(input) {
  const effort = effortArgs(input.effort);
  const model = input.nativeConfiguration && input.model === "default" ? [] : ["--model", input.model];
  const configuration = input.nativeConfiguration && !input.managedApi ? [] : [
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ autoMemoryEnabled: false, enabledPlugins: {}, ...input.managedApi ? { disableAllHooks: true } : {} }),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}'
  ];
  return [
    "-p",
    "--session-id",
    input.sessionId,
    ...model,
    ...streamArgs,
    ...configuration,
    "--permission-mode",
    input.mode === "read" ? "plan" : "bypassPermissions",
    "--json-schema",
    JSON.stringify(input.schema),
    ...effort
  ];
}
function encodeClaudeUserMessage(sessionId, userUuid, prompt) {
  return JSON.stringify({ type: "user", session_id: sessionId, uuid: userUuid, message: { role: "user", content: [{ type: "text", text: prompt }] } }) + "\n";
}
function encodeClaudeInterrupt(requestId) {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } }) + "\n";
}
function readClaudeStreamEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new SyntaxError("Claude stream-json returned invalid JSON");
  }
}
function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function jsonDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sortHistoryKeys(value) {
  if (Array.isArray(value)) return value.map(sortHistoryKeys);
  if (value === null || typeof value !== "object") return value;
  const row = (
    /** @type {Record<string, unknown>} */
    value
  );
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, sortHistoryKeys(row[key])]));
}
function claudeMessageDigest(value) {
  return jsonDigest(sortHistoryKeys(value));
}
function claudeMessageBlocks(message) {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}
function withoutHistoryCacheControl(value) {
  if (Array.isArray(value)) return value.map(withoutHistoryCacheControl);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== "cache_control" && item !== void 0).map(([key, item]) => [key, withoutHistoryCacheControl(item)]));
}
function claudeApiSourceDigest(message) {
  return claudeMessageDigest(withoutHistoryCacheControl({ ...message, content: claudeMessageBlocks(message) }));
}
function claudeApiRequestHashes(row, requests, shapes, model) {
  const base = row.base ? requests.get(row.base) : [];
  const keep = (
    /** @type {number} */
    row.keep
  );
  if (!row.id || requests.has(row.id) || !row.shapeHash || !shapes.has(row.shapeHash) || !base || !Number.isSafeInteger(keep) || keep < 0 || keep > base.length || !Array.isArray(row.tail) || row.model !== model) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude API model, tools shape or request history boundary differs");
  }
  return [...base.slice(0, keep), ...row.tail];
}
function projectClaudeRequestRetry(row) {
  const error = (
    /** @type {Record<string, unknown> | undefined} */
    row.error
  );
  if (typeof row.uuid !== "string" || !row.uuid || typeof row.parentUuid !== "string" || !row.parentUuid || row.agentId !== void 0 || !error || typeof error !== "object" || Array.isArray(error) || typeof error.message !== "string" || typeof error.formatted !== "string") {
    throw new ClaudeNativeProtocolError("stale_result", "Claude request retry has an unknown native error shape");
  }
  const retry = (
    /** @type {HistoryRetry} */
    {
      source: row.source,
      level: row.level,
      retryInMs: row.retryInMs,
      retryAttempt: row.retryAttempt,
      maxRetries: row.maxRetries,
      errorDigest: claudeMessageDigest(error)
    }
  );
  checkClaudeRequestRetry(retry);
  return retry;
}
function checkClaudeRequestRetry(retry) {
  if (!retry || !["request_retry", "connection_retry"].includes(retry.source) || retry.level !== "error" || !Number.isSafeInteger(retry.retryInMs) || retry.retryInMs < 0 || !Number.isSafeInteger(retry.retryAttempt) || retry.retryAttempt < 1 || !Number.isSafeInteger(retry.maxRetries) || retry.maxRetries < retry.retryAttempt || !/^[a-f0-9]{64}$/.test(retry.errorDigest)) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude API error is not an exact native request retry");
  }
}
function projectClaudePublicHistory(source, sessionId) {
  if (!source.endsWith("\n")) {
    throw new ClaudeNativeProtocolError("history_pending", "Claude native history has not flushed its final record");
  }
  const records = [];
  const paramsDigests = /* @__PURE__ */ new Map();
  let latestAssistant;
  for (const line of source.split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    const compact = row.type === "system" && row.subtype === "compact_boundary";
    const retry = row.type === "system" && row.subtype === "api_error";
    if (!compact && !retry && !historyRowTypes.includes(String(row.type))) continue;
    if (row.type === "api-request-blob" && row.message?.role !== "user") continue;
    if (row.sessionId !== sessionId || row.isSidechain === true) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude history contains a foreign session or sidechain");
    }
    if (row.type === "user" && row.isMeta === true && row.turnCompanion === true && row.message?.role === "user" && row.message.content === outputLimitRecoveryText && (!row.parentUuid || row.parentUuid !== latestAssistant?.uuid || latestAssistant.stopReason !== "max_tokens")) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude output-limit companion has no exact preceding max_tokens assistant");
    }
    const record2 = (
      /** @type {ClaudePublicRecord} */
      Object.fromEntries(historyRecordKeys.filter((key) => key in row).map((key) => [key, row[key]]))
    );
    if (retry) Object.assign(record2, { subtype: "api_error", requestRetry: projectClaudeRequestRetry(row) });
    if (compact) {
      const metadata = (
        /** @type {HistoryCompaction | undefined} */
        row.compactMetadata
      );
      Object.assign(record2, {
        subtype: row.subtype,
        logicalParentUuid: row.logicalParentUuid,
        compactMetadata: metadata && {
          runningTurnSends: metadata.runningTurnSends,
          ...metadata.preservedSegment !== void 0 ? { preservedSegment: metadata.preservedSegment } : {},
          ...metadata.preservedMessages !== void 0 ? { preservedMessages: metadata.preservedMessages } : {}
        }
      });
    }
    if (row.type === "user") {
      if (row.isCompactSummary === true) {
        const content = row.message?.content;
        record2.compactSummary = {
          transcriptOnly: row.isVisibleInTranscriptOnly === true,
          promptUuids: (
            /** @type {string[] | undefined} */
            row.summarizedTurnPromptUuids
          ),
          messageDigest: claudeMessageDigest(row.message),
          textOnly: row.message?.role === "user" && (typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === "text" && typeof block.text === "string"))
        };
      } else record2.message = row.message;
    }
    if (row.type === "api-request-blob") {
      const message = (
        /** @type {HistoryMessage} */
        row.message
      );
      const compactSummary = typeof message.content === "string";
      record2.message = compactSummary ? { ...message, content: claudeMessageBlocks(message) } : message;
      if (compactSummary) record2.compactSummaryDigest = claudeMessageDigest(message);
      record2.hash = String(row.hash);
    }
    if (row.type === "assistant") {
      const message = (
        /** @type {HistoryMessage} */
        row.message
      );
      record2.message = { role: "assistant", content: claudeMessageBlocks(message).filter((block) => block.type === "tool_use") };
      latestAssistant = { uuid: row.uuid, stopReason: row.message?.stop_reason };
    }
    if (row.type === "api-request") {
      const params = (
        /** @type {{model: string}} */
        row.params
      );
      Object.assign(record2, { id: row.id, shapeHash: row.shapeHash, base: row.base, keep: row.keep, tail: row.tail, model: params.model });
      paramsDigests.set(
        /** @type {string} */
        record2.id,
        claudeMessageDigest(params)
      );
    }
    if (row.type === "api-request-shape") {
      const shape = (
        /** @type {NonNullable<typeof row.shape>} */
        row.shape
      );
      record2.shapeHash = String(row.shapeHash);
      record2.toolNames = shape.tools.map((tool) => tool.name);
      record2.placeholderValid = shape.tools.filter((tool) => tool.name === "DeferredToolPlaceholder").every((tool) => tool.description === "Reserved placeholder that keeps deferred tool loading active; never call this tool." && tool.defer_loading === true && claudeMessageDigest(tool.input_schema) === claudeMessageDigest({ type: "object", properties: {} }));
    }
    records.push(record2);
  }
  return { records, paramsDigests };
}
function checkClaudeConnectionRetries(history, paramsDigests) {
  if (!history.some((row) => row.requestRetry?.source === "connection_retry")) return;
  const model = history.find((row) => row.type === "api-request")?.model;
  if (!model) throw new ClaudeNativeProtocolError("stale_result", "Claude connection retry has no preceding actual API model");
  const requests = /* @__PURE__ */ new Map();
  const shapes = /* @__PURE__ */ new Set();
  let latestChainNode;
  let current;
  let pending;
  let retriedRequest;
  for (const row of history) {
    if (row.type === "api-request-shape") shapes.add(
      /** @type {string} */
      row.shapeHash
    );
    if (row.type === "api-request") {
      const hashes = claudeApiRequestHashes(row, requests, shapes, model);
      const id = (
        /** @type {string} */
        row.id
      );
      requests.set(id, hashes);
      current = { id, shapeHash: (
        /** @type {string} */
        row.shapeHash
      ), paramsDigest: (
        /** @type {string} */
        paramsDigests.get(id)
      ), hashes };
      if (pending) {
        if (current.shapeHash !== pending.shapeHash || current.paramsDigest !== pending.paramsDigest || JSON.stringify(hashes) !== JSON.stringify(pending.hashes)) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude connection retry changed its exact API payload");
        }
        retriedRequest = id;
      }
    }
    if (row.requestRetry?.source === "connection_retry") {
      if (!current || row.parentUuid !== latestChainNode) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude connection retry lost its preceding request or exact chain tail");
      }
      pending = current;
      retriedRequest = void 0;
    }
    if (pending && (row.type === "user" || row.subtype === "compact_boundary")) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude connection retry inserted a new user or compact boundary before consumption");
    }
    if (pending && row.type === "assistant") {
      if (!retriedRequest || row.requestRef !== retriedRequest || row.parentUuid !== latestChainNode) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude connection retry lacks exact subsequent API and assistant consumption");
      }
      pending = void 0;
    }
    if (row.uuid) latestChainNode = row.uuid;
  }
  if (pending) throw new ClaudeNativeProtocolError("stale_result", "Claude connection retry has no subsequent API and assistant consumption");
}
function projectClaudeReplayHistory(source, sessionId) {
  const { records, paramsDigests } = projectClaudePublicHistory(source, sessionId);
  checkClaudeConnectionRetries(records, paramsDigests);
  return records;
}
function claudeMcpToolNames(source) {
  return source.split("\n").filter(Boolean).flatMap((line) => {
    const row = JSON.parse(line);
    if (row.type !== "request" || row.request?.method !== "tools/call") return [];
    if (typeof row.request.params?.name !== "string") {
      throw new ClaudeNativeProtocolError("stale_result", "Claude MCP call has no exact tool identity");
    }
    return [row.request.params.name];
  });
}
function claudeApiMessageBlobs(history) {
  const messages = /* @__PURE__ */ new Map();
  for (const row of history) {
    if (row.type !== "api-request-blob") continue;
    const { hash, message, compactSummaryDigest } = row;
    if (!message || message.role !== "user" || !Array.isArray(message.content) || hash !== claudeMessageDigest(message) || message.content.some((block) => !["tool_result", "text"].includes(block.type))) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude public API message has invalid bytes or type");
    }
    const blob = messages.get(hash) ?? {
      content: message.content,
      canonical: hash === claudeMessageDigest({ role: "user", content: message.content }),
      summaries: /* @__PURE__ */ new Set()
    };
    if (compactSummaryDigest) blob.summaries.add(compactSummaryDigest);
    messages.set(hash, blob);
  }
  return messages;
}
function claudeApiToolResultIds(content, responseBlocks) {
  return content.filter((block) => block.type === "tool_result").map((block) => {
    const callId = (
      /** @type {string} */
      block.tool_use_id
    );
    const original = responseBlocks.get(callId);
    if (!original || claudeMessageDigest(original) !== claudeMessageDigest(block)) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude merged API tool result differs from its exact native public reply");
    }
    return callId;
  });
}
function isClaudeStructuredOutputEnforcement(recovery) {
  return recovery?.text === structuredOutputEnforcement;
}
function isClaudeRecoveryMessageDigest(digest) {
  return recoveryTexts.some((text2) => digest === claudeMessageDigest({ role: "user", content: text2 }));
}
function claudeRecoveryCompanion(row, promptId, latestMessage, latestAssistant, outputLimitOnly = false) {
  const message = row.message;
  if (row.isMeta !== true || message?.role !== "user") return null;
  const enforcement = !outputLimitOnly && row.turnCompanion === void 0 && message.content === structuredOutputEnforcement;
  const text2 = enforcement ? structuredOutputEnforcement : row.turnCompanion === true ? (outputLimitOnly ? [outputLimitRecoveryText] : recoveryTexts).find((text3) => claudeMessageDigest(message) === claudeMessageDigest({ role: "user", content: text3 })) : void 0;
  if (text2 === void 0) return null;
  if (!row.uuid || !promptId || row.promptId !== promptId || row.sourceToolAssistantUUID !== void 0 || row.parentUuid !== latestMessage || row.parentUuid !== latestAssistant) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude recovery companion lost its exact native assistant or original prompt");
  }
  return {
    text: text2,
    hashes: /* @__PURE__ */ new Set([claudeMessageDigest(message), claudeMessageDigest({ role: "user", content: claudeMessageBlocks(message) })]),
    summaries: /* @__PURE__ */ new Set(),
    requests: /* @__PURE__ */ new Set(),
    consumed: false
  };
}
function claudeOutputLimitCompanions(history, original) {
  const companions = /* @__PURE__ */ new Map();
  let latestMessage, latestAssistant;
  for (const row of history) {
    if (row.type === "user" && row.uuid !== original?.uuid) {
      const recovery = claudeRecoveryCompanion(row, original?.promptId, latestMessage, latestAssistant, true);
      if (recovery) companions.set(
        /** @type {string} */
        row.uuid,
        recovery
      );
    }
    if (row.type === "assistant") latestAssistant = row.uuid;
    if (row.type === "user" || row.type === "assistant" || row.type === "system" && row.subtype === "api_error") latestMessage = row.uuid;
  }
  return companions;
}
function matchingClaudeRecoveries(recoveries, content, prompt) {
  const texts = content.filter((block) => block.type === "text");
  return recoveries.filter((recovery) => {
    const text2 = { type: "text", text: recovery.text };
    return JSON.stringify(texts) === JSON.stringify([text2]) || JSON.stringify(content) === JSON.stringify([{ type: "text", text: prompt + "\n" }, text2]);
  });
}
function recordClaudeRecoveryRequest(recoveries, row, hashes) {
  for (const recovery of recoveries) {
    if (row.tail?.some((hash) => recovery.hashes.has(hash)) || row.base && recovery.requests.has(row.base) && hashes.some((hash) => recovery.hashes.has(hash))) {
      recovery.requests.add(
        /** @type {string} */
        row.id
      );
    }
  }
}
function consumeClaudeRecoveryRequest(recoveries, requestRef) {
  const recovery = recoveries.at(-1);
  if (recovery && !recovery.requests.has(requestRef)) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude recovery companion has no new exact actual API consumer");
  }
  for (const item of recoveries) if (item.requests.has(requestRef)) item.consumed = true;
}
function* checkClaudeHistoryChain(history, original) {
  if (typeof original.uuid !== "string") throw new ClaudeNativeProtocolError("stale_result", "Claude original user has no native UUID");
  const { sessionId, uuid: userUuid, promptId } = original;
  const seen = /* @__PURE__ */ new Set();
  const parents = /* @__PURE__ */ new Map();
  let latestMessage, latestChainNode;
  let compaction;
  for (const row of history) {
    if (row.sessionId !== sessionId) throw new ClaudeNativeProtocolError("stale_result", "Claude native history changed its session identity");
    if (row.uuid !== void 0 && typeof row.uuid !== "string") throw new ClaudeNativeProtocolError("stale_result", "Claude public history has a non-string native UUID");
    const compact = row.type === "system" && row.subtype === "compact_boundary";
    const retry = row.type === "system" && row.subtype === "api_error";
    if (row.type === "system" && !compact && !retry) throw new ClaudeNativeProtocolError("stale_result", "Claude public system event is not a supported compact boundary");
    if (retry) {
      checkClaudeRequestRetry(row.requestRetry);
      if (typeof row.uuid !== "string" || !row.uuid || typeof row.parentUuid !== "string" || !row.parentUuid || row.parentUuid !== latestChainNode || compaction) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude request retry does not extend its exact native chain");
      }
    }
    if (compact) {
      const metadata = row.compactMetadata;
      const segment = metadata?.preservedSegment;
      const preserved = metadata?.preservedMessages;
      const logicalParent = row.logicalParentUuid;
      if (!row.uuid || seen.has(row.uuid) || row.parentUuid !== null || !logicalParent || logicalParent !== latestMessage || !seen.has(logicalParent) || compaction || metadata?.runningTurnSends?.openerUuid !== userUuid || JSON.stringify(metadata.runningTurnSends.uuids) !== JSON.stringify([userUuid])) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude compact boundary lost its exact running turn or logical parent");
      }
      if (segment !== void 0 || preserved !== void 0) {
        const ids = preserved?.allUuids;
        if (!segment || !preserved || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || JSON.stringify(preserved.uuids) !== JSON.stringify(ids) || segment.headUuid !== ids[0] || segment.tailUuid !== ids.at(-1) || segment.tailUuid !== logicalParent || !segment.anchorUuid || segment.anchorUuid !== preserved.anchorUuid || seen.has(segment.anchorUuid) || ids.some((id) => !seen.has(id))) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude compact preserved segment is not the exact observed chain");
        }
        const remaining = new Set(ids);
        let cursor = segment.tailUuid;
        while (cursor && cursor !== segment.headUuid && remaining.delete(cursor)) cursor = parents.get(cursor) ?? void 0;
        if (cursor !== segment.headUuid || !remaining.delete(segment.headUuid) || remaining.size) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude compact preserved segment is not the exact observed chain");
        }
      }
      compaction = { ancestors: /* @__PURE__ */ new Set([row.uuid]), ...segment ? { anchor: segment.anchorUuid } : {} };
      parents.set(row.uuid, logicalParent);
      seen.add(row.uuid);
      latestChainNode = row.uuid;
      yield row;
      continue;
    }
    if (row.uuid) {
      if (seen.has(row.uuid) || row.uuid !== userUuid && (!row.parentUuid || !seen.has(row.parentUuid))) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude public history is not the exact original main chain");
      }
      seen.add(row.uuid);
      parents.set(row.uuid, row.parentUuid ?? null);
      latestChainNode = row.uuid;
    }
    if (retry) {
      latestMessage = row.uuid;
      yield row;
      continue;
    }
    if (compaction && row.type === "attachment") {
      if (!row.uuid || !row.parentUuid || !compaction.ancestors.has(row.parentUuid)) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude compact attachment is outside its exact boundary");
      }
      compaction.ancestors.add(row.uuid);
    }
    if (row.compactSummary) {
      const summary = row.compactSummary;
      if (row.type !== "user" || row.turnCompanion !== void 0 || !row.uuid || !row.parentUuid || !compaction?.ancestors.has(row.parentUuid) || compaction.anchor && compaction.anchor !== row.uuid || row.promptId !== promptId || row.sourceToolAssistantUUID !== void 0 || !summary.transcriptOnly || !summary.textOnly || !/^[a-f0-9]{64}$/.test(summary.messageDigest) || JSON.stringify(summary.promptUuids) !== JSON.stringify([userUuid])) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude compact summary is not the exact original turn metadata");
      }
      compaction = void 0;
      latestMessage = row.uuid;
      yield row;
      continue;
    }
    if (compaction && ["user", "assistant", "api-request"].includes(row.type)) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude compact boundary has no exact same-turn summary");
    }
    if (row.type === "user" || row.type === "assistant") latestMessage = row.uuid;
    yield row;
  }
  if (compaction) throw new ClaudeNativeProtocolError("stale_result", "Claude compact boundary has no exact same-turn summary");
}
function projectClaudeApiSourceMetadata(source, sessionId, model, companionIds) {
  if (!source.endsWith("\n")) {
    throw new ClaudeNativeProtocolError("history_pending", "Claude native source history has not flushed its final record");
  }
  const sources = /* @__PURE__ */ new Map();
  const snapshots = /* @__PURE__ */ new Map();
  const requests = /* @__PURE__ */ new Map();
  const shapes = /* @__PURE__ */ new Set();
  let run;
  for (const [ordinal, line] of source.split("\n").filter(Boolean).entries()) {
    const row = JSON.parse(line);
    if (row.type === "fork-context-ref" || row.turnCompanion && !companionIds.has(String(row.uuid))) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude failed source index cannot interpret fork or recovery inputs");
    }
    const compact = row.type === "system" && row.subtype === "compact_boundary";
    const retry = row.type === "system" && row.subtype === "api_error";
    if (!compact && !retry && !historyRowTypes.includes(String(row.type))) continue;
    if (row.sessionId !== sessionId || row.isSidechain === true || row.agentId !== void 0) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude failed source index contains a foreign session or sidechain");
    }
    if (compact) {
      run = void 0;
      continue;
    }
    if (row.type === "api-request-shape") {
      if (typeof row.shapeHash !== "string") {
        throw new ClaudeNativeProtocolError("stale_result", "Claude failed source index has no shape identity");
      }
      shapes.add(row.shapeHash);
    }
    if (row.type === "api-request-blob") {
      const message = row.message;
      if (!message || message.role !== "user" && message.role !== "assistant" && message.role !== "system" || typeof message.content !== "string" && !Array.isArray(message.content)) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude failed source CAS has an unknown message role or shape");
      }
      const digest = claudeApiSourceDigest(message);
      if (row.hash !== digest) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude failed source CAS differs from its canonical digest");
      }
      if (sources.get(digest)?.kind !== "transcript-prefix") {
        sources.set(digest, { digest, role: message.role, kind: "cas", sourceUuids: [], ordinal });
      }
    }
    if (row.type === "user" || row.type === "assistant") {
      const message = row.message;
      if (!message || message.role !== row.type || typeof row.uuid !== "string" || typeof message.content !== "string" && !Array.isArray(message.content)) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude failed source transcript has a mismatched role or message identity");
      }
      if (!run || run.role !== message.role || message.role !== "user" && !(typeof message.id === "string" && run.messageId === message.id)) {
        run = { role: row.type, ...typeof message.id === "string" ? { messageId: message.id } : {}, blocks: [], uuids: [] };
      }
      run.blocks.push(...claudeMessageBlocks(message));
      run.uuids.push(row.uuid);
      const digest = claudeApiSourceDigest({ role: run.role, content: run.blocks });
      sources.set(digest, { digest, role: run.role, kind: "transcript-prefix", sourceUuids: [...run.uuids], ordinal });
    }
    if (row.type === "api-request") {
      if (typeof row.id !== "string") {
        throw new ClaudeNativeProtocolError("stale_result", "Claude failed source request has no exact identity");
      }
      const request = (
        /** @type {Pick<ClaudePublicRecord, 'id' | 'shapeHash' | 'base' | 'keep' | 'tail' | 'model'>} */
        { ...row, model: row.params?.model }
      );
      const hashes = claudeApiRequestHashes(request, requests, shapes, model);
      const messages = /* @__PURE__ */ new Map();
      for (const digest of hashes) {
        const observed = sources.get(digest);
        if (observed) messages.set(digest, observed);
      }
      snapshots.set(row.id, { ordinal, messages });
      requests.set(row.id, hashes);
    }
  }
  return snapshots;
}
function projectClaudeReplayApiSourceMetadata(source, sessionId, model) {
  if (!source.endsWith("\n")) {
    throw new ClaudeNativeProtocolError("history_pending", "Claude native source history has not flushed its final record");
  }
  const history = projectClaudeReplayHistory(source, sessionId);
  const original = history.find((row) => row.type === "user" && row.parentUuid === null);
  if (!original) throw new ClaudeNativeProtocolError("stale_result", "Claude failed source index has no original user");
  Array.from(checkClaudeHistoryChain(history, original));
  const companions = claudeOutputLimitCompanions(history, original);
  return projectClaudeApiSourceMetadata(source, sessionId, model, new Set(companions.keys()));
}
function claudeOriginalReplayMismatch(history) {
  if (history.some((row) => row.type === "user" && row.isMeta === true && row.turnCompanion === true && row.message?.role === "user" && row.message.content === outputLimitRecoveryText)) {
    return "Claude output-limit witness differs from its original native history";
  }
  if (history.some((row) => row.type === "user" && row.message?.content === structuredOutputEnforcement)) {
    return "Claude structured-output enforcement differs from its original native history";
  }
  if (history.some((row) => row.requestRetry?.source === "connection_retry")) {
    return "Claude connection retry witness differs from its original native history";
  }
}
function projectClaudeFrozenReadEvidence(witness, options) {
  const { sessionId, userUuid, promptId, prompt, model, result, echo, history } = witness;
  const { allowedTools, frozenToolName: frozenToolName2, mcpToolName, readNativeHistory, readMcpHistory } = options;
  if (witness.version !== 1 || witness.provider !== "claude-code" || witness.cliVersion !== CLAUDE_LEGACY_CLI_VERSION || !model || !promptId || result.type !== "result" || result.subtype !== "success" || result.is_error !== false || result.structured_output === void 0 || !claudeTerminalMatchesIdentity(result, { sessionId, userUuid }) || echo.uuid !== userUuid || echo.session_id !== sessionId || JSON.stringify([...witness.initTools].sort()) !== JSON.stringify([...allowedTools].sort())) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude completion lacks exact native identity or isolated capabilities");
  }
  const original = history.find((row) => row.type === "user" && row.uuid === userUuid);
  if (!original || original.parentUuid !== null || original.promptId !== promptId || JSON.stringify(original.message) !== JSON.stringify(echo.message) || !original.message || JSON.stringify({ ...original.message, content: claudeMessageBlocks(original.message) }) !== JSON.stringify({ role: "user", content: [{ type: "text", text: prompt }] })) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude original user echo/history/prompt identity differs");
  }
  const rawHistoryMismatch = claudeOriginalReplayMismatch(history);
  if (rawHistoryMismatch && JSON.stringify(projectClaudeReplayHistory(readNativeHistory(), sessionId)) !== JSON.stringify(history)) {
    throw new ClaudeNativeProtocolError("stale_result", rawHistoryMismatch);
  }
  if (witness.mcpHistory && (JSON.stringify(claudeMcpToolNames(readMcpHistory())) !== JSON.stringify(witness.mcpHistory.toolNames) || witness.mcpHistory.toolNames.some((name) => name !== mcpToolName))) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude MCP dispatched a foreign tool or its actual history changed");
  }
  const requests = /* @__PURE__ */ new Map();
  const shapes = /* @__PURE__ */ new Set(), compactSummaries = /* @__PURE__ */ new Set(), requestRefs = /* @__PURE__ */ new Set(), readerCalls = /* @__PURE__ */ new Set();
  const calls = /* @__PURE__ */ new Map();
  const responseMessages = /* @__PURE__ */ new Map();
  const responseBlocks = /* @__PURE__ */ new Map();
  const reads = [];
  const apiMessages = claudeApiMessageBlobs(history);
  const recoveries = [];
  const allowedShapeTools = [...allowedTools, "DeferredToolPlaceholder"];
  const originalHash = claudeMessageDigest(original.message);
  const originalBlocksHash = claudeMessageDigest({ role: "user", content: claudeMessageBlocks(original.message) });
  let latestMessage, latestAssistant;
  let acceptedOutput = false;
  for (const row of checkClaudeHistoryChain(history, original)) {
    if (row.type === "system") {
      if (row.subtype === "api_error") latestMessage = row.uuid;
      continue;
    }
    if (row.compactSummary) {
      const { messageDigest } = row.compactSummary;
      compactSummaries.add(messageDigest);
      for (const recovery of recoveries) {
        if (recovery.consumed) {
          recovery.summaries.add(messageDigest);
          recovery.hashes.add(messageDigest);
        }
      }
      latestMessage = row.uuid;
      continue;
    }
    if (row.type === "api-request-shape") {
      const { shapeHash, toolNames, placeholderValid } = row;
      if (!shapeHash || !/^[a-f0-9]{64}$/.test(shapeHash) || !toolNames || allowedTools.some((name) => !toolNames.includes(name)) || toolNames.some((name) => !allowedShapeTools.includes(name)) || !placeholderValid) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude API exposes a foreign or discoverable tool or has no shape identity");
      }
      shapes.add(shapeHash);
    }
    if (row.type === "api-request-blob") {
      const { compactSummaryDigest } = row;
      if (compactSummaryDigest && recoveries.length && isClaudeRecoveryMessageDigest(compactSummaryDigest)) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude recovery API message cannot masquerade as a compact summary");
      }
      if (compactSummaryDigest && !compactSummaries.has(compactSummaryDigest)) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude API string message is not an observed same-turn compact summary");
      }
      const blob = (
        /** @type {ClaudeApiMessageBlob} */
        apiMessages.get(
          /** @type {string} */
          row.hash
        )
      );
      claudeApiToolResultIds(blob.content, responseBlocks);
    }
    if (row.type === "api-request") {
      const hashes = claudeApiRequestHashes(row, requests, shapes, model);
      if (!requests.size && (!row.tail?.includes(originalHash) || row.keep !== 0 || row.base)) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude original user prompt was not in the actual first API request");
      }
      for (const hash of hashes) {
        const blob = apiMessages.get(hash);
        if (!blob) continue;
        for (const callId of claudeApiToolResultIds(blob.content, responseBlocks)) responseMessages.set(callId, hash);
        const summaries = [...blob.summaries].filter((digest) => compactSummaries.has(digest));
        if (compactSummaries.has(hash) || summaries.length) {
          for (const recovery of recoveries) {
            if (recovery.summaries.has(hash) || summaries.some((digest) => recovery.summaries.has(digest))) recovery.hashes.add(hash);
          }
          continue;
        }
        if (!blob.content.some((block) => block.type === "text")) continue;
        const matching = matchingClaudeRecoveries(recoveries, blob.content, prompt);
        if (!blob.canonical || hash !== originalHash && hash !== originalBlocksHash && !matching.length) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude API user message contains unobserved text or a different coalescing shape");
        }
        for (const recovery of matching) recovery.hashes.add(hash);
      }
      requests.set(
        /** @type {string} */
        row.id,
        hashes
      );
      recordClaudeRecoveryRequest(recoveries, row, hashes);
    }
    if (row.type === "assistant") {
      latestMessage = row.uuid;
      if (!row.requestRef || !requests.has(row.requestRef)) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude assistant lacks an exact actual API request reference");
      }
      consumeClaudeRecoveryRequest(recoveries, row.requestRef);
      latestAssistant = row.uuid;
      requestRefs.add(row.requestRef);
      for (const block of claudeMessageBlocks(
        /** @type {HistoryMessage} */
        row.message
      )) {
        if (!block.id || calls.has(block.id) || !block.name || block.name === "DeferredToolPlaceholder") {
          throw new ClaudeNativeProtocolError("stale_result", "Claude called a forbidden, placeholder or repeated tool");
        }
        if (isClaudeStructuredOutputEnforcement(recoveries.at(-1)) && block.name !== "StructuredOutput") {
          throw new ClaudeNativeProtocolError("stale_result", "Claude structured-output enforcement dispatched another tool");
        }
        calls.set(block.id, { row, block, recovery: recoveries.length });
      }
    }
    if (row.type === "user" && row.uuid !== userUuid) {
      const recovery = claudeRecoveryCompanion(row, promptId, latestMessage, latestAssistant);
      if (recovery) {
        if (isClaudeStructuredOutputEnforcement(recovery) && (acceptedOutput || recoveries.some(isClaudeStructuredOutputEnforcement))) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude structured-output enforcement is repeated or followed an accepted output");
        }
        recoveries.push(recovery);
        acceptedOutput = false;
        latestMessage = row.uuid;
        continue;
      }
      latestMessage = row.uuid;
      if (row.promptId !== promptId || !row.message || !Array.isArray(row.message.content) || !row.message.content.length || row.message.content.some((block) => block.type !== "tool_result")) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude history appended another user turn");
      }
      for (const reply of row.message.content) {
        const callId = (
          /** @type {string} */
          reply.tool_use_id
        );
        const call = calls.get(callId);
        if (!call || responseMessages.has(callId) || row.sourceToolAssistantUUID !== call.row.uuid || row.parentUuid !== call.row.uuid) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude tool result is not paired with its exact native call");
        }
        responseMessages.set(callId, claudeMessageDigest(row.message));
        responseBlocks.set(callId, reply);
        const name = (
          /** @type {string} */
          call.block.name
        );
        if (!allowedTools.includes(name)) {
          if (!witness.mcpHistory || reply.is_error !== true || reply.content !== `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`) {
            throw new ClaudeNativeProtocolError("stale_result", "Claude foreign tool call has no exact native non-dispatch rejection");
          }
          readerCalls.add(callId);
        } else if (name === "StructuredOutput") {
          if (!reply.is_error && call.recovery === recoveries.length && claudeMessageDigest(call.block.input) === claudeMessageDigest(result.structured_output)) acceptedOutput = true;
        } else if (name === frozenToolName2) {
          readerCalls.add(callId);
          const item = Array.isArray(reply.content) ? reply.content[0] : void 0;
          const text2 = !reply.is_error && item && typeof item === "object" && "text" in item && typeof item.text === "string" && JSON.stringify(reply.content) === JSON.stringify([{ type: "text", text: item.text }]) ? item.text : void 0;
          const error = reply.is_error === true && typeof reply.content === "string" ? reply.content : void 0;
          reads.push({ callId, input: call.block.input, ...text2 === void 0 ? {} : { text: text2 }, ...error === void 0 ? {} : { error } });
        }
      }
    }
    if (row.uuid === userUuid) latestMessage = row.uuid;
  }
  if (recoveries.some((recovery) => !recovery.consumed)) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude recovery companion has no new exact actual API consumer");
  }
  if (!acceptedOutput || [...calls.keys()].some((id) => !responseMessages.has(id))) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude result has no matching accepted schema tool output or has unanswered calls");
  }
  for (const callId of readerCalls) {
    const messageHash = (
      /** @type {string} */
      responseMessages.get(callId)
    );
    if (![...requests].some(([id, hashes]) => hashes.includes(messageHash) && requestRefs.has(id))) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude reader result was not present in a subsequent actual model API request");
    }
  }
  return reads;
}
function projectClaudeWorktreeSchemaFailure(history, original, { exactModel, isSchemaValid }) {
  const calls = /* @__PURE__ */ new Map();
  const responses = /* @__PURE__ */ new Map();
  const requests = /* @__PURE__ */ new Set();
  let latestMessage, latestAssistant;
  let schemaErrors = 0, enforcementSeen = false;
  let rejected;
  for (const row of checkClaudeHistoryChain(history, original)) {
    if (row.type === "api-request") {
      if (!row.id || exactModel !== void 0 && row.model !== exactModel) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude worktree schema failure model request differs");
      }
      requests.add(row.id);
    }
    if (row.type === "assistant" && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        if (!block.id || calls.has(block.id) || !row.requestRef || !requests.has(row.requestRef)) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude worktree schema failure has no exact native tool call");
        }
        calls.set(block.id, row);
      }
      latestAssistant = row.uuid;
    }
    if (row.type === "user" && row.uuid !== original.uuid && !row.compactSummary) {
      const recovery = claudeRecoveryCompanion(row, original.promptId, latestMessage, latestAssistant);
      if (isClaudeStructuredOutputEnforcement(recovery ?? void 0)) {
        if (enforcementSeen) throw new ClaudeNativeProtocolError("stale_result", "Claude worktree schema enforcement was repeated");
        enforcementSeen = true;
      }
      if (!recovery) {
        if (row.promptId !== original.promptId || !row.sourceToolAssistantUUID || row.sourceToolAssistantUUID !== row.parentUuid || !Array.isArray(row.message?.content) || !row.message.content.length) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude worktree schema failure contains another user input");
        }
        for (const reply of row.message.content) {
          const callId = reply.tool_use_id ?? "";
          const call = calls.get(callId);
          if (reply.type !== "tool_result" || !call || call.uuid !== row.sourceToolAssistantUUID || responses.has(callId)) {
            throw new ClaudeNativeProtocolError("stale_result", "Claude worktree schema error reply lost its exact native call");
          }
          responses.set(callId, reply);
          const block = Array.isArray(call.message?.content) ? call.message.content.find((block2) => block2.id === callId) : void 0;
          if (block && claudeStructuredOutputError(block.name, reply) !== void 0) {
            if (isSchemaValid(block.input)) {
              throw new ClaudeNativeProtocolError("stale_result", "Claude worktree schema error contradicts its pinned schema");
            }
            rejected = block.input;
            schemaErrors++;
          }
        }
      }
    }
    if (row.type === "user" || row.type === "assistant" || row.type === "system" && row.subtype === "api_error") latestMessage = row.uuid;
  }
  if (!requests.size || !schemaErrors) throw new ClaudeNativeProtocolError("stale_result", "Claude worktree exhaustion has no original native schema errors");
  return { calls, responses, rejected };
}
function projectClaudeFrozenSchemaFailure(history, source, original, options) {
  const { sessionId, userUuid, model, prompt, allowedTools, init, echo, result } = options;
  if (init.session_id !== sessionId || init.model !== model) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude complete native result lost its version, model or process-stop identity");
  }
  const requests = history.filter((row) => row.type === "api-request");
  const shapes = history.filter((row) => row.type === "api-request-shape");
  const summaryIds = new Set(Array.from(checkClaudeHistoryChain(history, original)).filter((row) => row.compactSummary).map((row) => row.uuid));
  const companions = claudeOutputLimitCompanions(history, original);
  const unknownUser = history.some((row) => {
    if (row.type !== "user" || row.uuid === userUuid || summaryIds.has(row.uuid) || companions.has(
      /** @type {string} */
      row.uuid
    )) return false;
    if (row.promptId !== original.promptId || !row.sourceToolAssistantUUID || row.parentUuid !== row.sourceToolAssistantUUID || row.message?.role !== "user" || !Array.isArray(row.message.content) || !row.message.content.length) return true;
    const assistant = history.find((candidate) => candidate.type === "assistant" && candidate.uuid === row.sourceToolAssistantUUID);
    const assistantBlocks = assistant?.message?.content;
    return row.message.content.some((block) => block.type !== "tool_result" || !Array.isArray(assistantBlocks) || !assistantBlocks.some((call) => call.type === "tool_use" && call.id === block.tool_use_id));
  });
  const allowedShapeTools = [...allowedTools, "DeferredToolPlaceholder"];
  const toolShapeMatches = (row) => shapes.some((shape) => shape.shapeHash === row.shapeHash && shape.placeholderValid && shape.toolNames && allowedTools.every((name) => shape.toolNames?.includes(name)) && shape.toolNames.every((name) => allowedShapeTools.includes(name)));
  if (result.type !== "result" || result.subtype !== "error_max_structured_output_retries" || result.is_error !== true || !claudeTerminalMatchesIdentity(result, { sessionId, userUuid }) || echo.uuid !== userUuid || echo.session_id !== sessionId || original.type !== "user" || original.uuid !== userUuid || !original.promptId || original.parentUuid !== null || !original.message || JSON.stringify(original.message) !== JSON.stringify(echo.message) || JSON.stringify(original.message) !== JSON.stringify({ role: "user", content: [{ type: "text", text: prompt }] }) || JSON.stringify([...init.tools].sort()) !== JSON.stringify([...allowedTools].sort()) || !requests.length || requests[0].keep !== 0 || requests[0].base || !requests[0].tail?.includes(claudeMessageDigest(original.message)) || requests.some((row) => row.model !== model || !toolShapeMatches(row)) || unknownUser || history.some((row) => row.sessionId !== sessionId || row.type === "assistant" && Array.isArray(row.message?.content) && row.message.content.some((block) => !block.name || !allowedTools.includes(block.name)))) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude schema retry exhaustion lost its exact terminal, API, original user or isolated capability identity");
  }
  const blobs = claudeApiMessageBlobs(history), metadata = projectClaudeReplayApiSourceMetadata(source, sessionId, model);
  const api = /* @__PURE__ */ new Map();
  const observedShapes = /* @__PURE__ */ new Set(), assistants = /* @__PURE__ */ new Set(), compactSummaries = /* @__PURE__ */ new Set();
  const users = /* @__PURE__ */ new Map();
  const calls = /* @__PURE__ */ new Map();
  const responses = /* @__PURE__ */ new Map();
  const recoveries = [];
  const originalHash = claudeMessageDigest(original.message);
  const originalBlocksHash = claudeMessageDigest({ role: "user", content: claudeMessageBlocks(original.message) });
  for (const row of history) {
    if (row.type === "system") continue;
    if (row.compactSummary) {
      const { messageDigest } = row.compactSummary;
      compactSummaries.add(messageDigest);
      for (const recovery of recoveries) {
        if (recovery.consumed) {
          recovery.summaries.add(messageDigest);
          recovery.hashes.add(messageDigest);
        }
      }
      continue;
    }
    const uuid = (
      /** @type {string} */
      row.uuid
    );
    if (row.turnCompanion && !companions.has(uuid)) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude schema retry exhaustion cannot classify unknown recovery user inputs");
    }
    if (row.type === "api-request-blob" && row.compactSummaryDigest && !compactSummaries.has(row.compactSummaryDigest)) {
      throw new ClaudeNativeProtocolError("stale_result", "Claude API string message is not an observed same-turn compact summary");
    }
    if (row.type === "api-request-shape") observedShapes.add(
      /** @type {string} */
      row.shapeHash
    );
    if (row.type === "assistant") {
      if (!row.requestRef || !api.has(row.requestRef)) {
        throw new ClaudeNativeProtocolError("stale_result", "Claude assistant has no preceding actual API request");
      }
      consumeClaudeRecoveryRequest(recoveries, row.requestRef);
      assistants.add(uuid);
      for (
        const block of
        /** @type {HistoryBlock[]} */
        row.message?.content
      ) {
        if (!block.id || calls.has(block.id)) throw new ClaudeNativeProtocolError("stale_result", "Claude schema failure reused a native tool call identity");
        calls.set(block.id, row);
      }
    }
    if (row.type === "user") {
      const recovery = companions.get(uuid);
      const message = (
        /** @type {HistoryMessage} */
        row.message
      );
      if (recovery) {
        recoveries.push(recovery);
        users.set(uuid, message);
        continue;
      }
      if (row.uuid !== userUuid) {
        for (
          const block of
          /** @type {HistoryBlock[]} */
          message.content
        ) {
          const callId = (
            /** @type {string} */
            block.tool_use_id
          );
          const call = calls.get(callId);
          if (!call || responses.has(callId) || call.uuid !== row.sourceToolAssistantUUID || call.uuid !== row.parentUuid) {
            throw new ClaudeNativeProtocolError("stale_result", "Claude schema failure tool reply has no preceding exact native call");
          }
          responses.set(callId, block);
        }
      }
      users.set(uuid, message);
    }
    if (row.type === "api-request") {
      const hashes = claudeApiRequestHashes(row, api, observedShapes, model);
      const id = (
        /** @type {string} */
        row.id
      );
      const requestSources = metadata.get(id);
      for (const digest of hashes) {
        const inputSource = requestSources?.messages.get(digest);
        if (!requestSources || !inputSource || inputSource.ordinal >= requestSources.ordinal) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude actual API input has no prior exact role source");
        }
        if (inputSource.role !== "user") {
          if (inputSource.kind === "transcript-prefix" && inputSource.sourceUuids.some((uuid2) => !assistants.has(uuid2))) {
            throw new ClaudeNativeProtocolError("stale_result", "Claude assistant source has no preceding public native identity");
          }
          continue;
        }
        const blob = blobs.get(digest);
        const summaryAliases = [...blob?.summaries ?? []].filter((hash) => compactSummaries.has(hash));
        if (compactSummaries.has(digest) || summaryAliases.length) {
          if (blob) claudeApiToolResultIds(blob.content, responses);
          for (const recovery of recoveries) {
            if (recovery.summaries.has(digest) || summaryAliases.some((hash) => recovery.summaries.has(hash))) recovery.hashes.add(digest);
          }
          continue;
        }
        let content = blob?.content;
        if (inputSource.kind === "transcript-prefix") {
          content = inputSource.sourceUuids.flatMap((uuid2) => {
            const message = users.get(uuid2);
            if (!message || !Array.isArray(message.content) && uuid2 !== userUuid && !companions.has(uuid2)) {
              throw new ClaudeNativeProtocolError("stale_result", "Claude user source UUID has no preceding authenticated public content");
            }
            return claudeMessageBlocks(message);
          });
        }
        if (!users.has(userUuid) || !Array.isArray(content) || !content.length || claudeApiSourceDigest({ role: "user", content }) !== digest || inputSource.kind === "cas" && blob && (!blob.canonical || blob.summaries.size)) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude actual API user message has no observed original prompt or exact tool reply source");
        }
        const matching = matchingClaudeRecoveries(recoveries, content, prompt);
        if (content.some((block) => block.type === "text") && digest !== originalHash && digest !== originalBlocksHash && !matching.length) {
          throw new ClaudeNativeProtocolError("stale_result", "Claude actual API user message contains unobserved recovery text");
        }
        for (const recovery of matching) recovery.hashes.add(digest);
        claudeApiToolResultIds(content, responses);
      }
      api.set(id, hashes);
      recordClaudeRecoveryRequest(recoveries, row, hashes);
    }
  }
  if (recoveries.some((recovery) => !recovery.consumed)) {
    throw new ClaudeNativeProtocolError("stale_result", "Claude recovery companion has no new exact actual API consumer");
  }
  return { calls, responses };
}
function claudeStructuredOutputError(callName, reply) {
  if (callName !== "StructuredOutput" || reply.is_error !== true || typeof reply.content !== "string" || !reply.content.startsWith(structuredOutputErrorPrefix)) return void 0;
  return [...reply.content.slice(structuredOutputErrorPrefix.length).matchAll(/(?:^|, )(\/[A-Za-z0-9_/-]{0,160}): (must be (?:array|object|string|number|integer|boolean|null)|must NOT have more than \d{1,8} items|must have required property '[A-Za-z0-9_-]{1,80}')(?=, | \(got \d+\)|$)/g)].slice(0, 12).map((match) => ({ path: match[1], error: match[2] }));
}
function claudeSchemaRetryDiagnostics(calls, responses) {
  return [...responses].flatMap(([callId, reply]) => {
    const content = calls.get(callId)?.message?.content;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(callId) || !Array.isArray(content)) return [];
    const tool = content.find((block) => block.id === callId && block.name === "StructuredOutput");
    const fields = claudeStructuredOutputError(tool?.name, reply);
    return fields?.length ? [{ callId, fields }] : [];
  }).slice(-5);
}
function claudeWorktreeTerminal(result) {
  const subtype = result.subtype === "error_max_structured_output_retries" ? "schema_exhausted" : result.subtype === "success" ? "success" : "other";
  const nativeResult = result.type === "result";
  return {
    subtype,
    isSuccess: nativeResult && subtype === "success" && result.is_error === false,
    isSchemaExhausted: nativeResult && subtype === "schema_exhausted" && result.is_error === true,
    isStoppedError: nativeResult && subtype === "success" && result.is_error === true && result.structured_output === void 0,
    mayRecoverFrozenRead: subtype === "schema_exhausted" || subtype === "success" && !result.is_error && result.structured_output !== void 0,
    reportedError: typeof result.is_error === "boolean" ? result.is_error : (
      /** @type {const} */
      "invalid"
    ),
    output: result.structured_output
  };
}
function claudeTerminalMatchesIdentity(result, { sessionId, userUuid }) {
  return result.session_id === sessionId && result.user_message_uuid === userUuid && Array.isArray(result.user_message_uuids) && result.user_message_uuids.length === 1 && result.user_message_uuids[0] === userUuid;
}
function claudeProtocolObservation(event, ordinal) {
  const init = event.type === "system" && event.subtype === "init";
  if (!init && event.type !== "result") return;
  const parent = event.parent_tool_use_id;
  return {
    version: 1,
    ordinal,
    kind: init ? "init" : "result",
    sessionId: typeof event.session_id === "string" ? event.session_id : void 0,
    uuid: typeof event.uuid === "string" ? event.uuid : void 0,
    parentToolUseIdOwn: Object.hasOwn(event, "parent_tool_use_id"),
    ...typeof parent === "string" || parent === null ? { parentToolUseId: parent } : {},
    ...init ? {
      modelDigest: typeof event.model === "string" ? jsonDigest(event.model) : void 0,
      toolsDigest: stringArray(event.tools) ? jsonDigest(event.tools) : void 0,
      toolsCount: Array.isArray(event.tools) ? event.tools.length : void 0
    } : {
      subtype: typeof event.subtype === "string" && /^[a-z0-9_-]{1,80}$/i.test(event.subtype) ? event.subtype : void 0,
      isError: typeof event.is_error === "boolean" ? event.is_error : void 0,
      userUuid: typeof event.user_message_uuid === "string" ? event.user_message_uuid : void 0,
      userUuidsDigest: stringArray(event.user_message_uuids) ? jsonDigest(event.user_message_uuids) : void 0,
      userUuidsCount: Array.isArray(event.user_message_uuids) ? event.user_message_uuids.length : void 0,
      structuredOutputOwn: Object.hasOwn(event, "structured_output")
    }
  };
}
function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isTokenCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function claudeModelUsage(value) {
  if (!isObject(value)) return;
  const models2 = Object.values(value);
  if (!models2.length || !models2.every(isObject)) return;
  const usage = { source: "claude-model-usage" };
  const fields = (
    /** @type {const} */
    [
      ["uncachedInputTokens", "inputTokens"],
      ["outputTokens", "outputTokens"],
      ["cacheReadInputTokens", "cacheReadInputTokens"],
      ["cacheWriteInputTokens", "cacheCreationInputTokens"]
    ]
  );
  for (const [field, nativeField] of fields) {
    const counts = models2.map((model) => model[nativeField]);
    if (!counts.every(isTokenCount)) continue;
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (Number.isSafeInteger(total)) usage[field] = total;
  }
  if (Object.keys(usage).length > 1) return usage;
}
function interpretClaudeStreamEvent(event, options) {
  if (event.type === "system" && event.subtype === "init") {
    if (options.hasInit) throw new ClaudeNativeProtocolError("stale_result", "Claude emitted more than one native init identity");
    const { session_id, model, tools } = (
      /** @type {ClaudeInit} */
      event
    );
    if (session_id !== options.sessionId || typeof model !== "string" || !model.trim() || !options.nativeConfiguration && model !== options.model || options.allowedTools && (!stringArray(tools) || JSON.stringify([...tools].sort()) !== JSON.stringify([...options.allowedTools].sort()))) {
      throw new ClaudeNativeProtocolError("unsupported", "Claude actual init model or tool surface differs from fixed isolation policy");
    }
    return { kind: "init", init: { session_id, model, tools } };
  }
  if (event.type === "user" && event.uuid === options.userUuid) {
    return {
      kind: "user-echo",
      echo: { uuid: String(event.uuid), session_id: String(event.session_id), message: (
        /** @type {ClaudeMessage} */
        event.message
      ) }
    };
  }
  if (event.type === "control_response" && options.interruptId) {
    const response = (
      /** @type {{request_id?: string, subtype?: string} | undefined} */
      event.response
    );
    if (response?.request_id === options.interruptId && response.subtype === "success") {
      return { kind: "interrupt-ack", requestId: response.request_id };
    }
  }
  if (event.type === "result") {
    const fields = ["type", "subtype", "is_error", "session_id", "uuid", "user_message_uuid", "user_message_uuids", "structured_output"];
    const result = (
      /** @type {ClaudeTerminalResult} */
      Object.fromEntries(fields.map((key) => [key, event[key]]))
    );
    const nativeTokenUsage = options.worktree && claudeModelUsage(event.modelUsage);
    const apiErrorStatus = options.worktree && options.managedRoute && event.is_error === true && event.api_error_status === 429 ? 429 : void 0;
    return { kind: "result", result, receipt: { ...result, ...nativeTokenUsage ? { nativeTokenUsage } : {}, apiErrorStatus } };
  }
}
function isClaudeRateLimitTerminal(result, exit) {
  return result.type === "result" && result.subtype === "success" && result.is_error === true && result.apiErrorStatus === 429 && exit.code === 1 && exit.signal === null;
}
var CLAUDE_LEGACY_CLI_VERSION, CLAUDE_VERSION_ARGS, authenticationKeys, isolatedSettings, streamArgs, ClaudeNativeProtocolError, truncatedRecoveryText, outputLimitRecoveryText, structuredOutputEnforcement, recoveryTexts, historyRecordKeys, historyRowTypes, structuredOutputErrorPrefix;
var init_claude = __esm({
  "src/llm_manager/native/claude.mjs"() {
    init_cli_probe();
    CLAUDE_LEGACY_CLI_VERSION = "2.1.309 (Claude Code)";
    CLAUDE_VERSION_ARGS = Object.freeze(["--version"]);
    authenticationKeys = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"];
    isolatedSettings = [
      "--restricted",
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, claudeMdExcludes: ["**"], enabledPlugins: {} })
    ];
    streamArgs = ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages"];
    ClaudeNativeProtocolError = class extends Error {
      /** @param {'unsupported' | 'stale_result' | 'history_pending'} code @param {string} message */
      constructor(code, message) {
        super(message);
        this.name = "ClaudeNativeProtocolError";
        this.code = code;
      }
    };
    truncatedRecoveryText = "Your response above was cut off mid-stream. Resume directly from where it stops \u2014 no apology, no recap. If none of it survived, answer the request from the start.";
    outputLimitRecoveryText = "Output token limit hit. Resume directly \u2014 no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";
    structuredOutputEnforcement = "[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.";
    recoveryTexts = [truncatedRecoveryText, outputLimitRecoveryText];
    historyRecordKeys = ["type", "sessionId", "uuid", "parentUuid", "promptId", "requestRef", "sourceToolAssistantUUID", "isMeta", "turnCompanion"];
    historyRowTypes = ["user", "assistant", "attachment", "api-request", "api-request-shape", "api-request-blob"];
    structuredOutputErrorPrefix = "Output does not match required schema: ";
  }
});

// src/llm_manager/native/codex-frozen.mjs
import { createHash as createHash2 } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync as readFileSync2, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join as join2 } from "node:path";
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? (
    /** @type {Packet} */
    value
  ) : {};
}
function codexPersistentConfig(readerRuntime) {
  const config = [
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    "[features]",
    ...readerRuntime ? codexPersistentDisabledFeatures.map((feature) => `${feature} = false`) : [],
    "apps = false",
    "plugins = false",
    "hooks = false",
    "multi_agent = false",
    "shell_tool = false",
    "code_mode = false",
    `code_mode_host = ${Boolean(readerRuntime)}`,
    "unified_exec = false",
    "[mcp_servers]",
    ""
  ];
  if (readerRuntime) {
    config.unshift(`model_catalog_json = ${JSON.stringify(readerRuntime.catalogPath)}`);
    if (readerRuntime.version === 2) config.splice(1, 0, `tool_output_token_limit = ${readerRuntime.toolOutputTokenLimit}`);
  }
  return config.join("\n");
}
function codexPersistentHomePaths(home) {
  return { configPath: join2(home, "config.toml"), authPath: join2(home, "auth.json") };
}
function assertCodexUnboundRealmHasNoRollouts(home) {
  const unproven = () => new CodexNativeProtocolError("stale_result", "The scoped Codex realm cannot prove that its native rollout trees are empty");
  const isReadableDirectory = (stat) => stat !== void 0 && stat.isDirectory() && (stat.mode & 0o444n) !== 0n && (stat.mode & 0o111n) !== 0n;
  try {
    if (!isAbsolute(home)) throw unproven();
    const homeStat = lstatSync(home, { bigint: true });
    if (!isReadableDirectory(homeStat)) throw unproven();
    const root = realpathSync(home);
    const directories = [
      { path: join2(root, "sessions"), levels: [/^\d{4}$/, /^(0[1-9]|1[0-2])$/, /^(0[1-9]|[12][0-9]|3[01])$/], optional: true },
      { path: join2(root, "archived_sessions"), levels: [], optional: true }
    ];
    const observed = /* @__PURE__ */ new Map([[root, homeStat]]);
    for (const { path, levels, optional } of directories) {
      const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (optional && stat === void 0) continue;
      if (!isReadableDirectory(stat) || realpathSync(path) !== path)
        throw unproven();
      observed.set(path, stat);
      for (const child of readdirSync(path, { withFileTypes: true })) {
        if (!child.isDirectory() || !levels[0]?.test(child.name)) throw unproven();
        directories.push({ path: join2(path, child.name), levels: levels.slice(1), optional: false });
      }
    }
    if (realpathSync(home) !== root) throw unproven();
    for (const [path, before] of observed) {
      const after = lstatSync(path, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)
        throw unproven();
    }
  } catch (error) {
    if (error instanceof CodexNativeProtocolError) throw error;
    throw unproven();
  }
}
function codexPersistentSocketPaths(socketPath, uid) {
  const rendezvous = join2(realpathSync(dirname(socketPath)), basename(socketPath));
  const daemonDirectory = join2("/private/tmp", `codex-daemon-${uid}`);
  const physicalSocket = join2(daemonDirectory, sha(Buffer.from(rendezvous)));
  return { rendezvous, daemonDirectory, physicalSocket, lockPath: `${physicalSocket}.lock` };
}
function models(value) {
  if (!Array.isArray(value) || !value.length || value.some((model) => typeof object(model).slug !== "string" || !model.slug))
    throw new CodexNativeProtocolError("unsupported", "Codex frozen model catalog has no complete native model rows");
  return value;
}
function readCatalogFile(path) {
  try {
    return readFileSync2(path);
  } catch {
    throw new CodexNativeProtocolError("unsupported", "Codex frozen model catalog source is unreadable");
  }
}
function parseCatalog(bytes) {
  try {
    return object(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new CodexNativeProtocolError("unsupported", "Codex frozen model catalog JSON is invalid");
  }
}
function codexBuildFrozenCatalog({ home, cliVersion, model }) {
  const cache = parseCatalog(readCatalogFile(join2(home, "models_cache.json")));
  if (`codex-cli ${cache.client_version}` !== cliVersion)
    throw new CodexNativeProtocolError("unsupported", "Codex frozen provider catalog has a different client version");
  const source = models(cache.models);
  if (model && !source.some((row) => row.slug === model))
    throw new CodexNativeProtocolError("unsupported", "Codex frozen model is absent from its isolated provider catalog");
  const stripped = source.map((row) => ({ ...row, apply_patch_tool_type: null, experimental_supported_tools: [] }));
  const bytes = Buffer.from(JSON.stringify({ models: stripped }));
  return {
    bytes,
    beforeDigest: sha(Buffer.from(JSON.stringify({ models: source }))),
    digest: sha(bytes),
    changedFields: ["apply_patch_tool_type", "experimental_supported_tools"]
  };
}
function codexAuditFrozenCatalog({ path, digest, model }) {
  const bytes = readCatalogFile(path);
  if (sha(bytes) !== digest) throw new CodexNativeProtocolError("unsupported", "Codex frozen model catalog digest differs");
  const entries = models(parseCatalog(bytes).models);
  if (entries.some((entry) => entry.apply_patch_tool_type !== null || !Array.isArray(entry.experimental_supported_tools) || entry.experimental_supported_tools.length))
    throw new CodexNativeProtocolError("unsupported", "Codex frozen model catalog still exposes native tools");
  if (model && !entries.some((entry) => entry.slug === model))
    throw new CodexNativeProtocolError("unsupported", "Requested model is absent from the Codex frozen catalog");
}
function codexFrozenToolDefinition() {
  return {
    type: "function",
    name: frozenToolName,
    description: 'Read immutable frozen context only. The index readBatches are a plan, not extra authorization: read every required unique content fully, using one exec per planned batch and at most its two listed adjacent ranges. Set each exec first-line // @exec: {"max_output_tokens": H} with H = execMaxOutputTokens from the index; call each listed read in order and print every returned string verbatim with its own text(await tools.spex_read_frozen(...)) call. If exec returns Script running with cell ID, do not rerun any read or advance the batch; call wait with {cell_id, yield_time_ms: 10000, max_tokens: H}, repeat with the same cell_id if still running, and wait for Script completed before continuing. A running marker is not read content; use the completed wait output, preserving each full text item. Optional entries remain available for reads as needed. Byte ranges are end-exclusive. Continue with startByte equal to the response original endByte; decodedStartByte/decodedEndByte only describe UTF-8 display expansion and are never cursors. No paths, live files, shell, or network are available.',
    inputSchema: { type: "object", properties: { contextDigest: { type: "string" }, entryId: { type: "string" }, startByte: { type: "integer", minimum: 0 }, endByte: { type: "integer", minimum: 0 } }, required: ["contextDigest", "entryId", "startByte", "endByte"], additionalProperties: false }
  };
}
function codexFrozenToolOutputTokenLimit(maxResponseBytes) {
  return Math.max(1e4, codexTextTokenCost(maxResponseBytes));
}
function codexFrozenPromptIndex({ contextDigest, maxReadBytes, maxResponseBytes, entries, plans }) {
  const toolOutputTokenLimit = codexFrozenToolOutputTokenLimit(maxResponseBytes);
  const execMaxOutputTokens = codexExecMaxOutputTokens(toolOutputTokenLimit);
  const readBatches = [];
  for (const { entryId, ranges } of plans) {
    for (let index2 = 0; index2 < ranges.length; ) {
      const first = ranges[index2];
      const second = ranges[index2 + 1];
      const batch = [{ startByte: first.startByte, endByte: first.endByte }];
      if (second && codexTextTokenCost(first.responseBytes) + codexTextTokenCost(second.responseBytes) <= toolOutputTokenLimit)
        batch.push({ startByte: second.startByte, endByte: second.endByte });
      readBatches.push({ entryId, ranges: batch });
      index2 += batch.length;
    }
  }
  const index = JSON.stringify({ tool: frozenToolName, contextDigest, maxReadBytes, toolOutputTokenLimit, execMaxOutputTokens, entries, readBatches });
  return { index, toolOutputTokenLimit };
}
function codexFrozenPrompt({ prompt, taskIsFrozen, ...options }) {
  const { index, toolOutputTokenLimit } = codexFrozenPromptIndex(options);
  const instructions = taskIsFrozen ? `The complete original task, instructions, and context are frozen without truncation in entry task. Read its entire required content using ${frozenToolName}, then follow that original task and return its requested structured final answer. Byte offsets are end-exclusive; continue from the response's original endByte, never decodedEndByte. No shell, paths or live data are available.` : prompt;
  return { prompt: `${instructions}
${index}`, toolOutputTokenLimit };
}
function codexFrozenToolResponse(text2) {
  return { contentItems: [{ type: (
    /** @type {const} */
    "inputText"
  ), text: text2 }], success: (
    /** @type {const} */
    true
  ) };
}
function codexFrozenPromptMatches(items, prompt) {
  const users = items.map(object).filter((item) => item.type === "userMessage");
  const content = users[0]?.content;
  return users.length === 1 && Array.isArray(content) && content.length === 1 && object(content[0]).type === "text" && object(content[0]).text === prompt;
}
function codexDecodeFrozenItems(items, toolName) {
  const final = [];
  const reads = [];
  const ids = /* @__PURE__ */ new Set();
  for (const value of items) {
    const item = object(value);
    if (item.type === "agentMessage" && item.phase === "final_answer") final.push(item.text);
    if (item.type !== "dynamicToolCall") continue;
    if (typeof item.id !== "string" || !item.id || ids.has(item.id) || item.tool !== toolName || item.namespace != null || item.status !== "completed" || item.success !== true || !Array.isArray(item.contentItems) || item.contentItems.length !== 1)
      throw new CodexNativeProtocolError("stale_result", "Codex frozen history contains an invalid, pending or foreign dynamic tool call");
    const body = object(item.contentItems[0]);
    if (body.type !== "inputText" || typeof body.text !== "string" || JSON.stringify(item.contentItems) !== JSON.stringify(codexFrozenToolResponse(body.text).contentItems))
      throw new CodexNativeProtocolError("stale_result", "Codex frozen dynamic result does not preserve its exact text body");
    ids.add(item.id);
    reads.push({ callId: item.id, arguments: item.arguments, text: body.text });
  }
  if (final.length !== 1 || typeof final[0] !== "string" || !final[0])
    throw new CodexNativeProtocolError("failed", "Codex exact frozen turn did not return one final answer");
  return { finalText: final[0], reads };
}
function readRolloutFile(path) {
  let fd;
  try {
    const physical = realpathSync(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout is not a regular file");
    const bytes = readFileSync2(fd);
    const after = fstatSync(fd, { bigint: true });
    if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size || after.size !== BigInt(bytes.length))
      throw new CodexNativeProtocolError("not_materialized", "Codex frozen rollout changed during its read");
    return { bytes, path: physical, dev: String(before.dev), ino: String(before.ino) };
  } catch (error) {
    if (error instanceof CodexNativeProtocolError) throw error;
    if (object(error).code === "ENOENT") throw new CodexNativeProtocolError("not_materialized", "The original Codex frozen rollout is missing");
    throw new CodexNativeProtocolError("stale_result", "The original Codex frozen rollout is unreadable");
  } finally {
    if (fd !== void 0) closeSync(fd);
  }
}
function decodeRolloutLine(line) {
  try {
    return object(JSON.parse(line));
  } catch {
    throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout contains invalid JSONL");
  }
}
function isCodexVisibleOutput(output) {
  return typeof output === "string" || Array.isArray(output) && output.every((block) => object(block).type === "input_text" && typeof object(block).text === "string");
}
function observeFrozenHostResponse(record2, payload, { calls, returned, outputs }, legacy = false) {
  const callId = (
    /** @type {string} */
    payload.call_id
  );
  const validId = legacy ? Boolean(callId) : typeof callId === "string" && callId.length > 0;
  if (payload.type === "custom_tool_call" || payload.type === "function_call") {
    const name2 = payload.type === "custom_tool_call" ? "exec" : "wait";
    if (payload.name !== name2 || !validId || calls.has(callId))
      throw new CodexNativeProtocolError("stale_result", legacy ? "frozen visible history contains an invalid or repeated host call" : "Codex frozen rollout contains an invalid or repeated host call");
    calls.set(callId, name2);
    return;
  }
  if (payload.type !== "custom_tool_call_output" && payload.type !== "function_call_output") return;
  const name = payload.type === "custom_tool_call_output" ? "exec" : "wait";
  const { output } = payload;
  const limit = object(record2.metadata).fallback_token_limit_override;
  if (!validId || calls.get(callId) !== name || returned.has(callId) || !isCodexVisibleOutput(output) || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)
    throw new CodexNativeProtocolError("stale_result", legacy ? "frozen visible output is not bound to its exact exec/wait call and history budget" : "Codex frozen rollout output does not match its exact host call and history budget");
  returned.add(callId);
  outputs.push({ callId, output, historyTokenLimit: limit });
}
function codexReadLegacyFrozenVisibleOutputs(rollout, turnId) {
  if (!rollout.endsWith("\n"))
    throw new CodexNativeProtocolError("not_materialized", "exact frozen visible rollout has not flushed its final record yet");
  const responses = { calls: /* @__PURE__ */ new Map(), returned: /* @__PURE__ */ new Set(), outputs: [] };
  let current;
  let completed = false;
  for (const line of rollout.split("\n")) {
    if (!line.trim()) continue;
    const record2 = JSON.parse(line);
    const payload = object(record2.payload);
    if (record2.type === "turn_context" || record2.type === "event_msg" && payload.type === "task_started")
      current = payload.turn_id;
    if (record2.type === "event_msg" && payload.type === "task_complete" && payload.turn_id === turnId) {
      if (current !== turnId)
        throw new CodexNativeProtocolError("stale_result", "frozen visible completion does not belong to the active exact turn");
      completed = true;
      current = void 0;
    }
    if (current === turnId && record2.type === "response_item") observeFrozenHostResponse(record2, payload, responses, true);
  }
  if (!completed)
    throw new CodexNativeProtocolError("not_materialized", "exact frozen visible rollout has not persisted its completed turn yet");
  if (responses.returned.size !== responses.calls.size)
    throw new CodexNativeProtocolError("stale_result", "frozen visible history contains an exec call without its output");
  return responses.outputs;
}
function decodeRollout(bytes, { threadId, turnId, cwd }, requireCompleted) {
  if (bytes.at(-1) !== 10)
    throw new CodexNativeProtocolError("not_materialized", "Codex frozen rollout has not flushed its last record");
  let string;
  try {
    string = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout is not UTF-8");
  }
  const lines = string.split("\n");
  const header = decodeRolloutLine(lines[0]);
  const meta = object(header.payload);
  if (header.type !== "session_meta" || meta.id !== threadId || meta.cwd !== cwd || meta.parent_thread_id != null)
    throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout does not identify the exact root thread and workspace");
  const responses = { calls: /* @__PURE__ */ new Map(), returned: /* @__PURE__ */ new Set(), outputs: [] };
  const turns = /* @__PURE__ */ new Set();
  const prompts = [];
  const finals = /* @__PURE__ */ new Set();
  let current;
  let completed = false;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const record2 = decodeRolloutLine(line);
    const payload = object(record2.payload);
    if (record2.type === "turn_context" || record2.type === "event_msg" && payload.type === "task_started") {
      current = payload.turn_id;
      if (typeof current === "string") turns.add(current);
    }
    if (record2.type === "event_msg" && payload.type === "task_complete" && payload.turn_id === turnId) {
      if (current !== turnId || completed)
        throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout completion does not belong to one exact turn");
      if (typeof payload.last_agent_message === "string") finals.add(payload.last_agent_message);
      completed = true;
      current = void 0;
    }
    if (current !== turnId) continue;
    if (record2.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") prompts.push(payload.message);
    if (record2.type === "event_msg" && payload.type === "agent_message" && payload.phase === "final_answer" && typeof payload.message === "string" && payload.message) finals.add(payload.message);
    if (record2.type === "response_item") observeFrozenHostResponse(record2, payload, responses);
  }
  if (turns.size && !turns.has(turnId))
    throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout contains a different turn");
  if (requireCompleted && !completed)
    throw new CodexNativeProtocolError("not_materialized", "Codex frozen rollout has not persisted its exact completed turn");
  if (completed && responses.returned.size !== responses.calls.size)
    throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout contains a completed host call without its output");
  return { outputs: responses.outputs, turns, prompts, finals };
}
function codexReadFrozenRollout(options) {
  const source = readRolloutFile(options.path);
  const history = decodeRollout(source.bytes, options, options.requireCompleted ?? true);
  if (!history.turns.has(options.turnId))
    throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout does not identify the exact turn");
  return { path: source.path, archived: basename(dirname(source.path)) === "archived_sessions", outputs: history.outputs };
}
function codexValidateFrozenVisibility(outputs, toolOutputTokenLimit, expectedResponses, legacy = false) {
  const budget = codexExecMaxOutputTokens(toolOutputTokenLimit);
  const callIds = /* @__PURE__ */ new Set();
  const texts = /* @__PURE__ */ new Set();
  const invalidBudget = legacy ? "frozen outer output exceeds or differs from its actual fixed history budget" : "Codex frozen model-visible body differs from its fixed history budget";
  for (const { callId, output, historyTokenLimit } of outputs) {
    if (!callId || callIds.has(callId) || historyTokenLimit !== budget || !isCodexVisibleOutput(output))
      throw new CodexNativeProtocolError("stale_result", invalidBudget);
    const bodies = typeof output === "string" ? [output] : output.map((block) => block.text);
    const cost = bodies.reduce((total, body) => total + codexTextTokenCost(Buffer.byteLength(body, "utf8")), 0);
    if (cost > budget) throw new CodexNativeProtocolError("stale_result", invalidBudget);
    callIds.add(callId);
    for (const body of bodies) texts.add(body);
  }
  if (expectedResponses.some((response) => !texts.has(response)))
    throw new CodexNativeProtocolError("stale_result", legacy ? "frozen response was not returned verbatim in the exact model-visible exec output" : "Codex frozen body was not returned verbatim in the exact model-visible history");
}
function readArchive(options, path, turn, items) {
  if (!options.generation || turn.id !== options.turnId || typeof turn.status !== "string" || !["completed", "failed", "interrupted"].includes(turn.status) || options.prompt !== void 0 && !codexFrozenPromptMatches(items, options.prompt))
    throw new CodexNativeProtocolError("stale_result", "Codex frozen archive history does not match its exact terminal turn or prompt");
  const source = readRolloutFile(path);
  const archiveDirectory = join2(realpathSync(options.home), "archived_sessions");
  if (dirname(source.path) !== archiveDirectory || !basename(source.path).startsWith("rollout-") || !basename(source.path).endsWith(`-${options.threadId}.jsonl`))
    throw new CodexNativeProtocolError("stale_result", "Codex frozen archive has no exact carrier in the scoped archive directory");
  const completed = turn.status === "completed";
  const history = decodeRollout(source.bytes, options, completed);
  if (history.turns.size !== 1 || !history.turns.has(options.turnId) || options.prompt !== void 0 && (history.prompts.length !== 1 || history.prompts[0] !== options.prompt))
    throw new CodexNativeProtocolError("stale_result", "Codex original archive does not identify one exact turn and its pinned prompt");
  let finalText;
  if (completed) {
    if (sha(Buffer.from(JSON.stringify(items))) !== options.expectedHistoryDigest)
      throw new CodexNativeProtocolError("stale_result", "Codex archived native items differ from their previously accepted complete history");
    const decoded = codexDecodeFrozenItems(items, options.toolName);
    finalText = decoded.finalText;
    const visible = new Set(history.outputs.flatMap((output) => typeof output.output === "string" ? [output.output] : output.output.map((block) => block.text)));
    if (history.finals.size !== 1 || !history.finals.has(finalText) || decoded.reads.some((read) => !visible.has(read.text)))
      throw new CodexNativeProtocolError("stale_result", "Codex original archive does not match the native final and every frozen tool response");
  }
  const { dev, ino } = source;
  const carrier = { path: source.path, sha256: sha(source.bytes), size: source.bytes.length, dev, ino };
  return { carrier, status: turn.status, outputs: history.outputs, finalText };
}
function sealCodexFrozenArchive(options, path, turn, items) {
  const { carrier, status } = readArchive(options, path, turn, items);
  const historyBytes = Buffer.from(JSON.stringify({ turn, items }));
  const receipt = {
    version: 1,
    generation: options.generation,
    threadId: options.threadId,
    turnId: options.turnId,
    cwd: options.cwd,
    status,
    carrier,
    historySha256: sha(historyBytes)
  };
  return { receipt, historyBytes };
}
function verifyCodexFrozenArchive(options, receipt, savedHistory) {
  const historyBytes = Buffer.from(savedHistory);
  if (receipt.version !== 1 || receipt.generation !== options.generation || receipt.threadId !== options.threadId || receipt.turnId !== options.turnId || receipt.cwd !== options.cwd || sha(historyBytes) !== receipt.historySha256)
    throw new CodexNativeProtocolError("stale_result", "Codex archive evidence does not match its generation, scope, identity or native history");
  const history = decodeRolloutLine(historyBytes.toString("utf8"));
  if (!Array.isArray(history.items)) throw new CodexNativeProtocolError("stale_result", "Codex frozen archive is missing raw native items");
  let archived;
  try {
    archived = readArchive(options, receipt.carrier.path, object(history.turn), history.items);
  } catch (error) {
    if (!(error instanceof CodexNativeProtocolError) || error.code !== "not_materialized") throw error;
    throw new CodexNativeProtocolError("stale_result", "The original Codex archive carrier is missing or incomplete");
  }
  if (archived.status !== receipt.status || archived.carrier.path !== receipt.carrier.path || archived.carrier.sha256 !== receipt.carrier.sha256 || archived.carrier.size !== receipt.carrier.size || archived.carrier.dev !== receipt.carrier.dev || archived.carrier.ino !== receipt.carrier.ino)
    throw new CodexNativeProtocolError("stale_result", "The original Codex archive carrier differs from the saved native evidence");
  return { status: archived.status, items: history.items, outputs: archived.outputs, finalText: archived.finalText };
}
var CodexNativeProtocolError, sha, codexPersistentDisabledFeatures, frozenToolName, codexTextTokenCost, codexExecMaxOutputTokens;
var init_codex_frozen = __esm({
  "src/llm_manager/native/codex-frozen.mjs"() {
    CodexNativeProtocolError = class extends Error {
      /** @param {ErrorCode} code @param {string} message @param {unknown} [cause] */
      constructor(code, message, cause) {
        super(message, { cause });
        this.name = "CodexNativeProtocolError";
        this.code = code;
      }
    };
    sha = (bytes) => createHash2("sha256").update(bytes).digest("hex");
    codexPersistentDisabledFeatures = Object.freeze([
      "goals",
      "view_image",
      "image_generation",
      "sleep_tool",
      "tool_suggest",
      "current_time_reminder",
      "send_message_to_user_async",
      "token_budget",
      "default_mode_request_user_input"
    ]);
    frozenToolName = "spex_read_frozen";
    codexTextTokenCost = (responseBytes) => Math.ceil(responseBytes / 4);
    codexExecMaxOutputTokens = (toolOutputTokenLimit) => Math.ceil(toolOutputTokenLimit * 1.2);
  }
});

// src/llm_manager/native/codex.mjs
var codex_exports = {};
__export(codex_exports, {
  CodexNativeAppServer: () => CodexNativeAppServer,
  CodexNativeProtocolError: () => CodexNativeProtocolError,
  CodexPersistentAppServer: () => CodexPersistentAppServer,
  assertCodexUnboundRealmHasNoRollouts: () => assertCodexUnboundRealmHasNoRollouts,
  codexAuditFrozenCatalog: () => codexAuditFrozenCatalog,
  codexBuildFrozenCatalog: () => codexBuildFrozenCatalog,
  codexDecodeFrozenItems: () => codexDecodeFrozenItems,
  codexFrozenPrompt: () => codexFrozenPrompt,
  codexFrozenPromptIndex: () => codexFrozenPromptIndex,
  codexFrozenToolDefinition: () => codexFrozenToolDefinition,
  codexFrozenToolOutputTokenLimit: () => codexFrozenToolOutputTokenLimit,
  codexNativeModel: () => codexNativeModel,
  codexNativeTokenUsage: () => codexNativeTokenUsage,
  codexNativeWorktreeArgs: () => codexNativeWorktreeArgs,
  codexPersistentAppServerArgs: () => codexPersistentAppServerArgs,
  codexPersistentConfig: () => codexPersistentConfig,
  codexPersistentDisabledFeatures: () => codexPersistentDisabledFeatures,
  codexPersistentHomePaths: () => codexPersistentHomePaths,
  codexPersistentSocketPaths: () => codexPersistentSocketPaths,
  codexPersistentTerminalError: () => terminalError,
  codexReadFrozenRollout: () => codexReadFrozenRollout,
  codexReadLegacyFrozenVisibleOutputs: () => codexReadLegacyFrozenVisibleOutputs,
  codexValidateFrozenVisibility: () => codexValidateFrozenVisibility,
  verifyCodexFrozenArchive: () => verifyCodexFrozenArchive
});
import { createHash as createHash3, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
function object2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? (
    /** @type {Packet} */
    value
  ) : {};
}
function nonempty(value) {
  return typeof value === "string" && value.length > 0;
}
function tokenCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function failed(message, cause) {
  return new CodexNativeProtocolError("failed", message, cause);
}
function codexNativeWorktreeArgs(root, tmp) {
  return [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    `sqlite_home=${JSON.stringify(root)}`,
    "-c",
    `log_dir=${JSON.stringify(tmp)}`,
    "-c",
    'history.persistence="none"',
    ...["apps", "plugins", "hooks", "code_mode", "code_mode_host"].flatMap((feature) => ["-c", `features.${feature}=false`])
  ];
}
function codexNativeModel(selection) {
  return selection === "default" ? void 0 : selection;
}
function codexNativeTokenUsage(total) {
  if (!total) return;
  const { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens } = total;
  if (!tokenCount(inputTokens) || !tokenCount(cachedInputTokens) || cachedInputTokens > inputTokens || !tokenCount(outputTokens))
    return;
  return {
    source: "codex-turn-usage",
    totalInputTokens: inputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens,
    cacheReadInputTokens: cachedInputTokens,
    outputTokens,
    ...tokenCount(cacheWriteInputTokens) ? { cacheWriteInputTokens } : {}
  };
}
function terminalError(turn) {
  if (turn?.status === "interrupted")
    return new CodexNativeProtocolError("cancelled", "Codex exact native turn was interrupted");
  const info = object2(turn?.error).codexErrorInfo;
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded")
    return new CodexNativeProtocolError("provider_quota_exhausted", `Codex exact native turn failed (${info})`);
  if (nonempty(info) && nativeErrorKinds.has(info)) return failed(`Codex exact native turn failed (${info})`);
  for (const kind of nativeHttpErrorKinds) {
    const status = object2(object2(info)[kind]).httpStatusCode;
    if (status === 429)
      return new CodexNativeProtocolError("provider_quota_exhausted", `Codex exact native turn failed (${kind}, HTTP 429)`);
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
      return failed(`Codex exact native turn failed (${kind}, HTTP ${status})`);
  }
  return failed("Codex exact native turn did not complete successfully");
}
function codexPersistentAppServerArgs(socketPath) {
  return ["app-server", "--strict-config", "--listen", `unix://${socketPath}`];
}
function encodeClientFrame(opcode, payload) {
  const length = payload.length;
  const header = Buffer.alloc(length < 126 ? 2 : length < 65536 ? 4 : 10);
  header[0] = 128 | opcode;
  header[1] = 128 | (header.length === 2 ? length : header.length === 4 ? 126 : 127);
  if (header.length === 4) header.writeUInt16BE(length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(length), 2);
  const mask = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
var CONTROL_MS, nativeErrorKinds, nativeHttpErrorKinds, CodexNativeAppServer, persistentThreadSourceKinds, CodexPersistentAppServer;
var init_codex = __esm({
  "src/llm_manager/native/codex.mjs"() {
    init_codex_frozen();
    init_codex_frozen();
    CONTROL_MS = 1e4;
    nativeErrorKinds = /* @__PURE__ */ new Set([
      "contextWindowExceeded",
      "sessionBudgetExceeded",
      "flexUnavailable",
      "serverOverloaded",
      "internalServerError",
      "unauthorized",
      "badRequest",
      "sandboxError",
      "other"
    ]);
    nativeHttpErrorKinds = [
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts"
    ];
    CodexNativeAppServer = class {
      #requestId = 0;
      /** @type {CodexNativeProtocolError | undefined} */
      #failure;
      /** @type {Map<number, { method: string, resolve(value: Packet): void, reject(error: Error): void }>} */
      #pending = /* @__PURE__ */ new Map();
      /** @type {import('node:stream').Writable} */
      #input;
      #streamEnded = false;
      /** @type {string | undefined} */
      #threadId;
      /** @type {string | undefined} */
      #turnId;
      /** @type {Map<string, Packet>} */
      #completions = /* @__PURE__ */ new Map();
      /** @type {Map<string, Packet[]>} */
      #finals = /* @__PURE__ */ new Map();
      /** @type {Map<string, Packet>} */
      #usages = /* @__PURE__ */ new Map();
      /** @type {() => void} */
      #wake = () => {
      };
      #terminal = new Promise((resolve2) => {
        this.#wake = () => resolve2(void 0);
      });
      /** @param {import('node:stream').Writable} input @param {import('node:stream').Readable} output */
      constructor(input, output) {
        this.#input = input;
        const lines = createInterface({ input: output });
        lines.on("line", (line) => {
          try {
            this.#receive(object2(JSON.parse(line)));
          } catch (error) {
            this.#setFailure(failed("Codex app-server returned an invalid native event", error));
          }
        });
        lines.on("close", () => {
          this.#streamEnded = true;
          this.#setFailure(failed("Codex app-server closed its native stream"));
        });
        output.on("error", (error) => this.#setFailure(failed("Codex app-server output failed", error)));
        input.on("error", (error) => this.#setFailure(failed("Codex app-server input failed", error)));
      }
      get failure() {
        return this.#failure;
      }
      /** @param {unknown} cause */
      fail(cause) {
        this.#setFailure(failed("Codex worktree observation failed", cause));
      }
      /** @param {CodexNativeProtocolError} error */
      #setFailure(error) {
        this.#failure ??= error;
        for (const waiter of this.#pending.values()) waiter.reject(this.#failure);
        this.#pending.clear();
        this.#wake();
      }
      /** @param {Packet} packet */
      #send(packet) {
        this.#input.write(JSON.stringify(packet) + "\n");
      }
      /** @param {Packet} packet */
      #receive(packet) {
        if (nonempty(packet.method)) {
          if (packet.id !== void 0) {
            this.#send({ id: packet.id, error: { code: -32601, message: "Worktree execution grants no interactive requests or approvals" } });
          } else {
            this.#observe(packet.method, object2(packet.params));
          }
        } else if (typeof packet.id === "number") {
          const waiter = this.#pending.get(packet.id);
          this.#pending.delete(packet.id);
          if (waiter && packet.error) waiter.reject(failed(`Codex app-server rejected ${waiter.method}`));
          else waiter?.resolve(object2(packet.result));
        }
      }
      /** @param {string} method @param {Packet} params */
      #observe(method, params) {
        if (!this.#threadId || params.threadId !== this.#threadId) return;
        if (method === "turn/completed") {
          const turn = object2(params.turn);
          if (!nonempty(turn.id)) return;
          if (this.#completions.has(turn.id)) throw failed("Codex repeated its exact terminal event");
          this.#completions.set(turn.id, turn);
          if (turn.id === this.#turnId) this.#wake();
        } else if (nonempty(params.turnId)) {
          if (method === "item/completed") {
            const item = object2(params.item);
            if (item.type === "agentMessage" && item.phase === "final_answer")
              this.#finals.set(params.turnId, [...this.#finals.get(params.turnId) ?? [], item]);
          } else if (method === "thread/tokenUsage/updated") {
            this.#usages.set(params.turnId, object2(object2(params.tokenUsage).total));
          }
        }
      }
      /** @param {string} method @param {Packet} params @returns {Promise<Packet>} */
      async #request(method, params) {
        if (this.#failure) throw this.#failure;
        const id = ++this.#requestId;
        let timer;
        try {
          return await new Promise((resolve2, reject) => {
            this.#pending.set(id, { method, resolve: resolve2, reject });
            timer = setTimeout(() => reject(failed(`Codex app-server did not answer ${method}`)), CONTROL_MS);
            this.#send({ id, method, params });
          });
        } finally {
          clearTimeout(timer);
          this.#pending.delete(id);
        }
      }
      /** @param {string} clientName @param {string} version */
      async initialize(clientName, version) {
        await this.#request("initialize", {
          clientInfo: { name: clientName, version },
          capabilities: { experimentalApi: true }
        });
        this.#send({ method: "initialized", params: {} });
      }
      /** @param {WorktreeOptions & { beforeStart?: () => void }} options @returns {Promise<Thread>} */
      async startThread({ workspace, model, permissions, beforeStart }) {
        const effective = object2((await this.#request("config/read", { cwd: workspace, includeLayers: false })).config);
        const config = {
          ...permissions?.shellPath ? { "shell_environment_policy.set.PATH": permissions.shellPath, allow_login_shell: false } : {},
          ...permissions ? {
            [`permissions.${permissions.name}.filesystem`]: Object.fromEntries([
              [":root", "read"],
              ...permissions.writableRoots.map((path) => [path, "write"])
            ]),
            [`permissions.${permissions.name}.network.enabled`]: false
          } : {},
          mcp_servers: Object.fromEntries(Object.keys(object2(effective.mcp_servers)).map((server) => [server, { enabled: false }]))
        };
        beforeStart?.();
        const thread = await this.#request("thread/start", {
          cwd: workspace,
          runtimeWorkspaceRoots: [workspace],
          approvalPolicy: "never",
          ephemeral: true,
          config,
          ...model === void 0 ? {} : { model },
          allowProviderModelFallback: false,
          ...permissions ? { permissions: permissions.name } : { sandbox: "read-only" }
        });
        const row = object2(thread.thread);
        const sandbox = object2(thread.sandbox);
        const profile = object2(thread.activePermissionProfile);
        if (!nonempty(row.id) || row.cwd !== workspace || row.ephemeral !== true || row.path !== null || !nonempty(row.cliVersion) || thread.cwd !== workspace || thread.approvalPolicy !== "never" || sandbox.networkAccess !== false || !Array.isArray(thread.runtimeWorkspaceRoots) || thread.runtimeWorkspaceRoots.length !== 1 || thread.runtimeWorkspaceRoots[0] !== workspace || !nonempty(thread.model) || model !== void 0 && thread.model !== model || (permissions ? profile.id !== permissions.name || sandbox.type !== "workspaceWrite" || !Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.some((path) => !permissions.writableRoots.includes(path)) : sandbox.type !== "readOnly"))
          throw new CodexNativeProtocolError("unsupported", "Codex did not confirm the exact model, worktree and permission boundary");
        this.#threadId = row.id;
        return { id: row.id, cwd: workspace, model: thread.model, cliVersion: row.cliVersion };
      }
      /** @param {WorktreeOptions & { prompt: string, schema: Packet, effort?: string }} options @returns {Promise<string>} */
      async startTurn({ workspace, prompt, schema, model, effort, permissions }) {
        if (!this.#threadId) throw failed("Codex has no accepted native thread identity");
        const accepted = object2((await this.#request("turn/start", {
          threadId: this.#threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          cwd: workspace,
          approvalPolicy: "never",
          runtimeWorkspaceRoots: [workspace],
          outputSchema: schema,
          ...model === void 0 ? {} : { model },
          ...effort ? { effort } : {},
          ...permissions ? { permissions: permissions.name } : { sandboxPolicy: { type: "readOnly", networkAccess: false } }
        })).turn);
        if (!nonempty(accepted.id)) throw failed("Codex returned no accepted native turn identity");
        this.#turnId = accepted.id;
        if (this.#completions.has(accepted.id)) this.#wake();
        return accepted.id;
      }
      /** @returns {Promise<void>} */
      async waitForTerminal() {
        await this.#terminal;
      }
      /** @returns {Promise<TurnIdentity | undefined>} */
      async interrupt() {
        const threadId = this.#threadId;
        const turnId = this.#turnId;
        try {
          if (!threadId || !turnId || this.#streamEnded || this.#completions.get(turnId)?.status === "completed") return;
          const identity = { threadId, turnId };
          const reply = await Promise.race([this.#request("turn/interrupt", identity), delay(750).then(() => null)]);
          if (reply) {
            await Promise.race([this.#terminal, delay(250)]);
            if (this.#completions.get(turnId)?.status === "interrupted") return identity;
          }
        } finally {
          this.#wake();
        }
      }
      /** @returns {Final} */
      readFinal() {
        if (this.#failure) throw this.#failure;
        const threadId = this.#threadId;
        const turnId = this.#turnId;
        if (!threadId || !turnId) throw failed("Codex has no accepted native turn identity");
        const turn = this.#completions.get(turnId);
        if (turn?.status !== "completed") throw terminalError(turn);
        const answers = this.#finals.get(turnId);
        const usage = this.#usages.get(turnId);
        if (answers?.length !== 1 || !nonempty(answers[0].id) || !nonempty(answers[0].text))
          throw failed("Codex exact native turn did not return one final answer");
        return {
          threadId,
          turnId,
          status: "completed",
          itemId: answers[0].id,
          text: answers[0].text,
          ...usage ? { tokenUsage: usage } : {}
        };
      }
    };
    persistentThreadSourceKinds = [
      "cli",
      "vscode",
      "exec",
      "appServer",
      "subAgent",
      "subAgentReview",
      "subAgentCompact",
      "subAgentThreadSpawn",
      "subAgentOther",
      "unknown"
    ];
    CodexPersistentAppServer = class {
      /** @type {import('node:net').Socket} */
      #socket;
      /** @type {number} */
      #requestTimeoutMs;
      #requestId = 0;
      /** @type {Buffer} */
      #buffer = Buffer.alloc(0);
      /** @type {Buffer[]} */
      #fragments = [];
      #upgraded = false;
      /** @type {Promise<void>} */
      #ready;
      /** @type {CodexNativeProtocolError | undefined} */
      #failure;
      #closed = false;
      /** @type {Map<number, RpcWaiter>} */
      #pending = /* @__PURE__ */ new Map();
      /** @type {((error: CodexNativeProtocolError) => void) | undefined} */
      #onFailure;
      /** @type {((threadId: string, turn: PersistentTurn) => void) | undefined} */
      #onCompleted;
      /** @type {((call: Packet) => Promise<Packet>) | undefined} */
      #onToolCall;
      #toolWork = Promise.resolve();
      /** @param {string} socketPath @param {number} [requestTimeoutMs] */
      constructor(socketPath, requestTimeoutMs = 3e4) {
        this.#requestTimeoutMs = requestTimeoutMs;
        this.#socket = createConnection(socketPath);
        const key = randomBytes(16).toString("base64");
        const accept = createHash3("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        this.#ready = new Promise((resolve2, reject) => {
          const timer = setTimeout(() => this.#fail(new CodexNativeProtocolError("transport", "Codex persistent WebSocket upgrade timed out")), requestTimeoutMs);
          const disconnected = (error) => {
            clearTimeout(timer);
            reject(error);
            this.#fail(error);
          };
          this.#socket.once("connect", () => this.#socket.write(
            `GET /rpc HTTP/1.1\r
Host: localhost\r
Connection: Upgrade\r
Upgrade: websocket\r
Sec-WebSocket-Version: 13\r
Sec-WebSocket-Key: ${key}\r
\r
`
          ));
          this.#socket.on("error", () => disconnected(new CodexNativeProtocolError("transport", "Codex persistent transport disconnected")));
          this.#socket.on("close", () => disconnected(new CodexNativeProtocolError("transport", "Codex persistent transport closed")));
          this.#socket.on("data", (chunk) => {
            try {
              this.#buffer = Buffer.concat([this.#buffer, chunk]);
              if (!this.#upgraded) {
                const end = this.#buffer.indexOf("\r\n\r\n");
                if (end === -1 && this.#buffer.length <= 65536) return;
                const headers = this.#buffer.subarray(0, end).toString("utf8");
                const challenge = /^Sec-WebSocket-Accept:[ \t]*(\S+)/im.exec(headers);
                if (end === -1 || !/^HTTP\/1\.1 101(?:\s|$)/.test(headers) || challenge && challenge[1] !== accept)
                  throw new Error("Codex persistent WebSocket upgrade refused");
                this.#buffer = this.#buffer.subarray(end + 4);
                this.#upgraded = true;
                clearTimeout(timer);
                resolve2();
              }
              this.#drainFrames();
            } catch {
              disconnected(new CodexNativeProtocolError("transport", "Codex persistent transport returned an invalid WebSocket or RPC packet"));
            }
          });
        });
        void this.#ready.catch(() => {
        });
      }
      /** @param {CodexNativeProtocolError} error */
      #fail(error) {
        if (this.#closed) return;
        this.#closed = true;
        this.#failure = error;
        this.#socket.destroy();
        for (const waiter of this.#pending.values()) waiter.reject(error);
        this.#pending.clear();
        this.#onFailure?.(error);
      }
      close() {
        this.#onFailure = void 0;
        this.#fail(new CodexNativeProtocolError("transport", "Codex persistent observer detached"));
      }
      /** @param {(error: CodexNativeProtocolError) => void} handler */
      onFailure(handler) {
        this.#onFailure = handler;
        if (this.#failure) handler(this.#failure);
      }
      /** @param {(threadId: string, turn: PersistentTurn) => void} handler */
      onCompleted(handler) {
        this.#onCompleted = handler;
      }
      /** @param {(call: Packet) => Promise<Packet>} handler */
      onToolCall(handler) {
        this.#onToolCall = handler;
      }
      /** @param {string} toolName @param {(call: TurnIdentity & { callId: string, arguments: unknown }) => Promise<string>} handler */
      onFrozenToolCall(toolName, handler) {
        this.onToolCall(async (call) => {
          const { threadId, turnId, callId } = call;
          if (!nonempty(threadId) || !nonempty(turnId) || !nonempty(callId) || call.tool !== toolName || call.namespace != null)
            throw new CodexNativeProtocolError("stale_result", "Codex frozen tool call has no exact thread, turn and tool binding");
          return codexFrozenToolResponse(await handler({ threadId, turnId, callId, arguments: call.arguments }));
        });
      }
      async drainToolCalls() {
        await this.#toolWork;
        if (this.#failure) throw this.#failure;
      }
      #drainFrames() {
        while (this.#buffer.length >= 2 && !this.#closed) {
          const data = this.#buffer;
          const opcode = data[0] & 15;
          const final = (data[0] & 128) !== 0;
          const width = data[1] & 127;
          const offset = width < 126 ? 2 : width === 126 ? 4 : 10;
          if (data.length < offset) return;
          const length = width < 126 ? width : width === 126 ? data.readUInt16BE(2) : Number(data.readBigUInt64BE(2));
          if (data[0] & 112 || data[1] & 128 || !Number.isSafeInteger(length))
            throw new Error("Invalid Codex WebSocket frame");
          if (length > data.length - offset) return;
          const payload = data.subarray(offset, offset + length);
          this.#buffer = data.subarray(offset + length);
          if (opcode >= 8) {
            if (!final || length > 125 || opcode > 10) throw new Error("Invalid Codex WebSocket control frame");
            if (opcode === 8) {
              this.#fail(new CodexNativeProtocolError("transport", "Codex persistent WebSocket closed"));
              return;
            }
            if (opcode === 9) this.#socket.write(encodeClientFrame(10, payload));
            continue;
          }
          if (opcode !== (this.#fragments.length ? 0 : 1)) throw new Error("Invalid Codex WebSocket text continuation");
          this.#fragments.push(payload);
          if (final) {
            const json = Buffer.concat(this.#fragments).toString("utf8");
            this.#fragments = [];
            this.#receive(object2(JSON.parse(json)));
          }
        }
      }
      /** @param {Packet} packet */
      #send(packet) {
        if (this.#failure) throw this.#failure;
        this.#socket.write(encodeClientFrame(1, Buffer.from(JSON.stringify(packet), "utf8")));
      }
      /** @param {Packet} packet */
      #receive(packet) {
        const { id, method } = packet;
        if (typeof id === "number" && !method) {
          const waiter = this.#pending.get(id);
          if (!waiter) return;
          this.#pending.delete(id);
          if (packet.error) {
            const { message } = object2(packet.error);
            if (nonempty(message) && (message.includes("rollout at ") && message.includes(" is empty") || message.includes("is not materialized yet"))) {
              waiter.reject(new CodexNativeProtocolError("not_materialized", "Codex persistent rollout is not materialized yet"));
            } else {
              waiter.reject(failed(`Codex persistent ${waiter.method} was refused`));
            }
          } else if (packet.result && typeof packet.result === "object" && !Array.isArray(packet.result)) {
            waiter.resolve(object2(packet.result));
          } else {
            waiter.reject(new CodexNativeProtocolError("transport", `Codex persistent ${waiter.method} response has no result object`));
          }
          return;
        }
        const params = object2(packet.params);
        if (method === "turn/completed" && nonempty(params.threadId)) {
          const turn = object2(params.turn);
          if (nonempty(turn.id) && nonempty(turn.status))
            this.#onCompleted?.(
              params.threadId,
              /** @type {PersistentTurn} */
              turn
            );
        }
        if (id === void 0 || !method) return;
        const onToolCall = this.#onToolCall;
        if (method === "item/tool/call" && onToolCall) {
          this.#toolWork = this.#toolWork.then(async () => {
            if (this.#failure) throw this.#failure;
            const result = await onToolCall(params);
            this.#send({ id, result });
          }).catch(() => {
            this.#fail(new CodexNativeProtocolError("cancellation_pending", "Codex persistent tool request was refused; exact native stop is required"));
            throw this.#failure;
          });
          void this.#toolWork.catch(() => {
          });
          return;
        }
        this.#send({ id, error: { code: -32601, message: "Codex persistent transport grants no external tools or approvals" } });
      }
      /** @param {string} method @param {Packet} params @returns {Promise<Packet>} */
      async #request(method, params) {
        await this.#ready;
        if (this.#failure) throw this.#failure;
        const id = ++this.#requestId;
        const timer = setTimeout(() => this.#fail(new CodexNativeProtocolError("transport", `Codex persistent ${method} timed out`)), this.#requestTimeoutMs);
        try {
          return await new Promise((resolve2, reject) => {
            this.#pending.set(id, { method, resolve: resolve2, reject });
            this.#send({ id, method, params });
          });
        } finally {
          this.#pending.delete(id);
          clearTimeout(timer);
        }
      }
      /** @param {string} clientName @param {string} version */
      async initialize(clientName, version) {
        await this.#request("initialize", { clientInfo: { name: clientName, version }, capabilities: { experimentalApi: true } });
        this.#send({ method: "initialized", params: {} });
      }
      /** @param {{ cwd: string, readerRuntime?: ReaderConfiguration }} options */
      async auditReadOnly({ cwd, readerRuntime }) {
        const config = object2((await this.#request("config/read", { cwd, includeLayers: false })).config);
        const features = object2(config.features);
        const mcpServers = config.mcp_servers;
        const disabled = ["apps", "plugins", "hooks", "shell_tool", "code_mode"];
        if (config.sandbox_mode !== "read-only" || config.approval_policy !== "never" || disabled.some((feature) => features[feature] !== false) || features.code_mode_host !== !!readerRuntime || mcpServers != null && (object2(mcpServers) !== mcpServers || Object.keys(mcpServers).length) || readerRuntime && (config.model_catalog_json !== readerRuntime.catalogPath || codexPersistentDisabledFeatures.some((feature) => features[feature] !== false) || readerRuntime.version === 2 && config.tool_output_token_limit !== readerRuntime.toolOutputTokenLimit))
          throw new CodexNativeProtocolError("unsupported", "Effective Codex config cannot prove the fixed read-only policy");
        const hooks = await this.#request("hooks/list", { cwds: [cwd] });
        if (!Array.isArray(hooks.data) || hooks.data.some((entry) => !Array.isArray(object2(entry).hooks) || entry.hooks.length || entry.errors?.length))
          throw new CodexNativeProtocolError("unsupported", "Effective Codex hooks are present or could not be audited");
        const servers = await this.#request("mcpServerStatus/list", {});
        if (!Array.isArray(servers.data) || servers.data.length || servers.nextCursor)
          throw new CodexNativeProtocolError("unsupported", "Effective Codex MCP servers are present or could not be audited");
      }
      /** @param {{ cwd: string, model?: string, dynamicTools?: Packet[] }} options @returns {Promise<PersistentThread>} */
      async startThread({ cwd, model, dynamicTools }) {
        const result = await this.#request("thread/start", {
          cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          ...model ? { model } : {},
          ...dynamicTools ? { dynamicTools } : {}
        });
        const thread = object2(result.thread);
        if (!nonempty(thread.id)) throw failed("Codex returned no persistent thread identity");
        if (thread.ephemeral === true) throw new CodexNativeProtocolError("unsupported", "Codex opened an ephemeral thread for a persistent request");
        if (model && result.model !== model) throw new CodexNativeProtocolError("unsupported", "Codex did not confirm the requested persistent model");
        return (
          /** @type {PersistentThread} */
          thread
        );
      }
      /** @param {{ threadId: string, cwd: string }} options @returns {Promise<PersistentThread>} */
      async resumeThread({ threadId, cwd }) {
        const result = await this.#request("thread/resume", { threadId, cwd, approvalPolicy: "never", sandbox: "read-only", excludeTurns: true });
        const thread = object2(result.thread);
        if (thread.id !== threadId) throw new CodexNativeProtocolError("stale_result", "Codex resumed a different persistent thread");
        if (thread.ephemeral === true) throw new CodexNativeProtocolError("unsupported", "Codex resumed an ephemeral thread for a persistent request");
        return (
          /** @type {PersistentThread} */
          thread
        );
      }
      /** @param {{ threadId: string, cwd: string, prompt: string, schema: Packet, model?: string, effort?: string }} options */
      async startTurn({ threadId, cwd, prompt, schema, model, effort }) {
        const result = await this.#request("turn/start", {
          threadId,
          cwd,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
          outputSchema: schema,
          ...model ? { model } : {},
          ...effort ? { effort } : {}
        });
        const turn = object2(result.turn);
        if (!nonempty(turn.id)) throw failed("Codex returned no persistent turn identity");
        return turn.id;
      }
      /**
       * @param {string} method @param {Packet} params
       * @param {(data: unknown[]) => boolean} [matches]
       * @returns {Promise<unknown[]>}
       */
      async #pages(method, params, matches) {
        const data = [];
        const cursors = /* @__PURE__ */ new Set();
        let cursor;
        do {
          const page = await this.#request(method, { ...params, ...cursor ? { cursor } : {} });
          if (!Array.isArray(page.data)) throw new CodexNativeProtocolError("stale_result", `Codex persistent ${method} returned no page data`);
          data.push(...page.data);
          if (matches?.(page.data)) break;
          cursor = page.nextCursor;
          if (cursor == null || cursor === "") break;
          if (!nonempty(cursor) || cursors.has(cursor))
            throw new CodexNativeProtocolError("stale_result", `Codex persistent ${method} returned an invalid or repeated cursor`);
          cursors.add(cursor);
        } while (cursor);
        return data;
      }
      /** @param {string} threadId @param {string} [turnId] @returns {Promise<PersistentTurn[]>} */
      async readTurns(threadId, turnId) {
        const rows = await this.#pages(
          "thread/turns/list",
          { threadId, limit: 100, itemsView: "notLoaded" },
          turnId ? (page) => page.some((row) => object2(row).id === turnId) : void 0
        );
        return rows.map((row) => {
          const turn = object2(row);
          if (!nonempty(turn.id) || !nonempty(turn.status))
            throw new CodexNativeProtocolError("stale_result", "Codex persistent turn page contains no exact turn identity or status");
          return (
            /** @type {PersistentTurn} */
            turn
          );
        });
      }
      /** @param {string} threadId @param {string} turnId */
      async readItems(threadId, turnId) {
        const rows = await this.#pages("thread/items/list", { threadId, turnId, limit: 16, sortDirection: "asc" });
        return rows.map((row) => {
          const { turnId: owner, item } = object2(row);
          if (owner !== turnId || !nonempty(object2(item).type))
            throw new CodexNativeProtocolError("stale_result", "Codex persistent item page does not belong to the exact turn");
          return object2(item);
        });
      }
      /** @param {{ threadId: string, turnId?: string, prompt: string }} options */
      async readExactTurn({ threadId, turnId, prompt }) {
        const turns = await this.readTurns(threadId);
        if (!turnId && !turns.length) throw new CodexNativeProtocolError("no_turn", "Codex durable thread has no accepted turn");
        const candidates = turnId ? turns.filter((turn2) => turn2.id === turnId) : turns;
        const turn = candidates[0];
        if (candidates.length !== 1 || !["inProgress", "completed", "failed", "interrupted"].includes(turn.status) || !turnId && !codexFrozenPromptMatches(await this.readItems(threadId, turn.id), prompt))
          throw new CodexNativeProtocolError("stale_result", "Codex frozen exact turn or pinned first prompt could not be proven");
        return turn;
      }
      /** @param {string} threadId @param {boolean} [includeTurns] @returns {Promise<PersistentThread>} */
      async readThread(threadId, includeTurns = false) {
        const result = await this.#request("thread/read", { threadId, includeTurns });
        const thread = object2(result.thread);
        if (thread.id !== threadId) throw new CodexNativeProtocolError("stale_result", "Codex read back a different persistent thread");
        return (
          /** @type {PersistentThread} */
          thread
        );
      }
      /** @param {string} threadId @param {string} turnId */
      async interrupt(threadId, turnId) {
        await this.#request("turn/interrupt", { threadId, turnId });
      }
      async refreshModels() {
        const rows = await this.#pages("model/list", { includeHidden: true, limit: 100 });
        const ids = rows.map((row) => object2(row).id).filter(nonempty);
        if (!ids.length) throw new CodexNativeProtocolError("unsupported", "Codex persistent provider model catalog is empty");
        return [...new Set(ids)];
      }
      async listLoadedThreadIds() {
        const rows = await this.#pages("thread/loaded/list", { limit: 100 });
        const ids = rows.map((row) => typeof row === "string" ? row : object2(row).id ?? object2(row).threadId);
        if (!ids.every(nonempty)) throw new CodexNativeProtocolError("stale_result", "Codex persistent loaded thread list contains no exact identity");
        return [...new Set(
          /** @type {string[]} */
          ids
        )];
      }
      /** @param {string} cwd @param {boolean} archived @returns {Promise<string[]>} */
      async listThreads(cwd, archived) {
        const rows = await this.#pages("thread/list", {
          cwd,
          archived,
          sourceKinds: persistentThreadSourceKinds,
          useStateDbOnly: true,
          limit: 100
        });
        const ids = rows.map((row) => {
          const thread = object2(row);
          if (!nonempty(thread.id) || thread.cwd !== cwd)
            throw new CodexNativeProtocolError("stale_result", "Codex persistent thread list does not prove the requested working directory scope");
          return thread.id;
        });
        return [...new Set(ids)];
      }
      /** @param {string} threadId */
      async archiveThread(threadId) {
        if (!nonempty(threadId)) throw new CodexNativeProtocolError("stale_result", "Codex persistent archive requires an exact thread identity");
        await this.#request("thread/archive", { threadId });
      }
      /** @param {import('./codex-frozen.mjs').ArchiveOptions} options */
      async captureFrozenArchive(options) {
        const { threadId, turnId } = options;
        const turns = await this.readTurns(threadId);
        if (turns.length !== 1 || turns[0].id !== turnId)
          throw new CodexNativeProtocolError("stale_result", "Codex frozen archive requires precisely its one original turn");
        const items = await this.readItems(threadId, turnId);
        const thread = await this.readThread(threadId);
        if (!nonempty(thread.path)) throw new CodexNativeProtocolError("not_materialized", "Codex frozen archive carrier is not yet materialized");
        return sealCodexFrozenArchive(options, thread.path, turns[0], items);
      }
    };
  }
});

// src/llm_manager/native/cursor.mjs
var cursor_exports = {};
__export(cursor_exports, {
  CURSOR_COMMAND: () => CURSOR_COMMAND,
  CURSOR_VERSION_ARGS: () => CURSOR_VERSION_ARGS,
  CursorAcpError: () => CursorAcpError,
  cursorAcpCancel: () => cursorAcpCancel,
  cursorAcpInitialize: () => cursorAcpInitialize,
  cursorLaunchArgs: () => cursorLaunchArgs,
  cursorModelArgument: () => cursorModelArgument,
  cursorTerminalCancelled: () => cursorTerminalCancelled,
  cursorTerminalCompleted: () => cursorTerminalCompleted,
  cursorUsageLimitNotice: () => cursorUsageLimitNotice,
  encodeCursorAcpPacket: () => encodeCursorAcpPacket,
  inspectCursorCliVersion: () => inspectCursorCliVersion,
  observeCursorAcp: () => observeCursorAcp
});
import { randomUUID } from "node:crypto";
import { isAbsolute as isAbsolute2, relative, resolve } from "node:path";
import { createInterface as createInterface2 } from "node:readline";
function inspectCursorCliVersion(launch) {
  const version = runNativeCliProbe(launch, CURSOR_VERSION_ARGS);
  const cliVersion = version.stdout?.trim();
  if (version.status !== 0 || !cliVersion) {
    throw new CursorAcpError("unsupported", "Cursor CLI did not report a version");
  }
  return cliVersion;
}
function cursorTerminalCompleted(output) {
  return output?.stopReason === "end_turn";
}
function cursorTerminalCancelled(output) {
  return output?.stopReason === "cancelled";
}
function cursorModelArgument(value) {
  if (!value.trim() || value.includes("\0")) {
    throw new CursorAcpError("unsupported", "Cursor CLI requires cursor:<model> or cursor:default");
  }
  return value === "default" ? void 0 : value;
}
function cursorLaunchArgs(workspace, mode, model) {
  return [
    "--workspace",
    workspace,
    "--sandbox",
    "enabled",
    "--trust",
    ...mode === "read" ? ["--mode", "ask"] : [],
    ...model === void 0 ? [] : ["--model", model],
    "acp"
  ];
}
function cursorAcpInitialize() {
  return { id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } };
}
function cursorAcpCancel(sessionId) {
  return { method: "session/cancel", params: { sessionId } };
}
function encodeCursorAcpPacket(packet) {
  return JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n";
}
function reportedModel(packet) {
  const modelConfig = Array.isArray(packet.configOptions) ? packet.configOptions.map(object3).find((option) => option?.category === "model" && option.type === "select") : void 0;
  const value = modelConfig?.currentValue ?? object3(packet.models)?.currentModelId;
  return nonempty2(value) ? value : void 0;
}
function permissionResult(params, plan, sessionId) {
  if (params?.sessionId !== sessionId || !sessionId) return { outcome: { outcome: "cancelled" } };
  const tool = object3(params?.toolCall);
  const withinWorktree = (location) => {
    const path = object3(location)?.path;
    if (!nonempty2(path)) return false;
    const fromWorkspace = relative(plan.workspace, resolve(plan.workspace, path));
    return !isAbsolute2(fromWorkspace) && fromWorkspace !== ".." && !fromWorkspace.startsWith("../") && fromWorkspace !== ".git" && !fromWorkspace.startsWith(".git/");
  };
  const editable = plan.mode === "edit" && tool?.kind === "edit" && Array.isArray(tool.locations) && tool.locations.length > 0 && tool.locations.every(withinWorktree);
  const allow = tool?.kind === "read" || tool?.kind === "search" || editable;
  const option = Array.isArray(params?.options) ? params.options.map(object3).find((entry) => entry?.kind === (allow ? "allow_once" : "reject_once")) : void 0;
  return nonempty2(option?.optionId) ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}
async function observeCursorAcp(stdout, plan, prompt, send, hooks) {
  const lines = createInterface2({ input: stdout, crlfDelay: Infinity });
  const chunks = [];
  let awaiting = 1;
  let sessionId, model;
  let request;
  let terminal;
  let textOnlyWithoutTools = true;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let packet;
      try {
        packet = object3(JSON.parse(line));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new CursorAcpError("cancellation_pending", "Cursor ACP stream contains invalid JSON");
      }
      if (packet?.jsonrpc !== "2.0") throw new CursorAcpError("cancellation_pending", "Cursor ACP stream contains an invalid envelope");
      if (typeof packet.method === "string") {
        const params = object3(packet.params);
        if (typeof packet.id === "string" || typeof packet.id === "number") {
          if (packet.method === "session/request_permission") {
            if (request && params?.sessionId === sessionId) textOnlyWithoutTools = false;
            const result2 = hooks.isInterrupted() || terminal || !request ? { outcome: { outcome: "cancelled" } } : permissionResult(params, plan, sessionId);
            send({ id: packet.id, result: result2 });
          } else {
            send({ id: packet.id, error: { code: -32601, message: "Client method unavailable" } });
          }
        } else if (packet.method === "session/update" && request && params?.sessionId === sessionId) {
          const update = object3(params?.update);
          if (terminal) {
            if (update?.sessionUpdate === "available_commands_update" && !Object.hasOwn(packet, "id") && !Object.hasOwn(packet, "result") && !Object.hasOwn(packet, "error") && Array.isArray(update.availableCommands) && update.availableCommands.every((value) => {
              const command = object3(value);
              return typeof command?.name === "string" && typeof command.description === "string" && (command.input == null || typeof object3(command.input)?.hint === "string");
            })) continue;
            throw new CursorAcpError("cancellation_pending", "Cursor ACP emitted session updates after its original prompt terminal");
          }
          if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
            textOnlyWithoutTools = false;
            chunks.length = 0;
          } else if (update?.sessionUpdate === "agent_message_chunk") {
            const content = object3(update.content);
            if (content?.type === "text") {
              if (typeof content.text !== "string") throw new CursorAcpError("cancellation_pending", "Cursor ACP assistant text chunk is malformed");
              chunks.push(content.text);
            } else {
              textOnlyWithoutTools = false;
            }
          } else if (update?.sessionUpdate === "config_option_update") {
            model = reportedModel(update) ?? model;
          } else if (update?.sessionUpdate === "current_mode_update" && plan.mode === "read" && update.currentModeId !== "ask") {
            throw new CursorAcpError("cancellation_pending", "Cursor ACP read session changed to an unverified mode");
          }
        }
        continue;
      }
      if (terminal || packet.id !== awaiting || Object.hasOwn(packet, "result") === Object.hasOwn(packet, "error")) {
        throw new CursorAcpError("cancellation_pending", "Cursor ACP response differs from its original request");
      }
      const rpcError = object3(packet.error);
      const result = object3(packet.result);
      if (rpcError && request && hooks.onProviderQuota && !hooks.isInterrupted()) {
        const status = rpcError.code === 429 || object3(rpcError.data)?.statusCode === 429;
        if (status || cursorUsageLimitNotice(rpcError.message)) {
          hooks.onProviderQuota(request, status ? "http_429" : "usage_limit");
          throw new CursorAcpError("provider_quota_exhausted", "Cursor provider reported quota exhaustion for the original ACP prompt", {
            threadId: request.sessionId,
            turnId: request.requestId
          });
        }
      }
      if (rpcError?.code === -32e3 && typeof rpcError.message === "string" && /^authentication required[.!]?$/i.test(rpcError.message.trim())) {
        throw new CursorAcpError("failed", "Cursor CLI authentication is required");
      }
      if (!result) {
        throw new CursorAcpError("failed", typeof awaiting === "number" ? "Cursor ACP session could not be started" : "Cursor ACP prompt returned an error");
      }
      if (awaiting === 1) {
        if (result.protocolVersion !== 1) throw new CursorAcpError("unsupported", "Cursor CLI does not negotiate ACP protocol v1");
        awaiting = 2;
        send({ id: awaiting, method: "session/new", params: { cwd: plan.workspace, mcpServers: [] } });
        continue;
      }
      if (awaiting === 2) {
        if (!nonempty2(result.sessionId)) throw new CursorAcpError("failed", "Cursor ACP session/new did not return a session ID");
        sessionId = result.sessionId;
        await hooks.onSession(sessionId);
        model = reportedModel(result);
        const modes = object3(result.modes);
        if (plan.mode === "read" && modes?.currentModeId !== "ask") {
          if (!Array.isArray(modes?.availableModes) || !modes.availableModes.some((mode) => object3(mode)?.id === "ask")) {
            throw new CursorAcpError("unsupported", "Cursor ACP session does not advertise the ask mode");
          }
          if (hooks.isInterrupted()) break;
          awaiting = 3;
          send({ id: awaiting, method: "session/set_mode", params: { sessionId, modeId: "ask" } });
          continue;
        }
      }
      if (awaiting === 2 || awaiting === 3) {
        const binding = { planDigest: plan.planDigest, sessionId: (
          /** @type {string} */
          sessionId
        ), requestId: randomUUID(), ...model === void 0 ? {} : { reportedModel: model } };
        if (!await hooks.startPrompt(binding) || hooks.isInterrupted()) break;
        request = binding;
        awaiting = request.requestId;
        send({ id: awaiting, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: prompt }] } });
      } else {
        if (!request || !nonempty2(result.stopReason)) throw new CursorAcpError("cancellation_pending", "Cursor ACP lacks the original prompt stop reason");
        model = reportedModel(result) ?? model;
        terminal = { requestDigest: hooks.digestRequest(request), stopReason: result.stopReason, ...model === void 0 ? {} : { reportedModel: model }, text: chunks.join("") };
        hooks.onTerminal(terminal);
      }
    }
  } finally {
    lines.close();
  }
  if (!terminal) {
    throw request ? new CursorAcpError("cancellation_pending", "Cursor ACP stream closed without its original prompt terminal") : new CursorAcpError("failed", "Cursor ACP closed before prompt dispatch");
  }
  return { output: terminal, textOnlyWithoutTools };
}
var CURSOR_COMMAND, CURSOR_VERSION_ARGS, CursorAcpError, object3, nonempty2, cursorUsageLimitNotice;
var init_cursor = __esm({
  "src/llm_manager/native/cursor.mjs"() {
    init_cli_probe();
    CURSOR_COMMAND = "cursor-agent";
    CURSOR_VERSION_ARGS = Object.freeze(["--version"]);
    CursorAcpError = class extends Error {
      /**
       * @param {AcpErrorCode} code
       * @param {string} message
       * @param {{threadId: string, turnId: string}} [detail]
       */
      constructor(code, message, detail) {
        super(message);
        this.name = "CursorAcpError";
        this.code = code;
        this.detail = detail;
      }
    };
    object3 = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? (
      /** @type {RpcObject} */
      value
    ) : void 0;
    nonempty2 = (value) => typeof value === "string" && !!value.trim();
    cursorUsageLimitNotice = (value) => typeof value === "string" && /^(?:Upgrade your plan to continue|You've hit your usage limit)[.!]?$/iu.test(value.trim());
  }
});

// src/llm_manager/native/grok.mjs
var grok_exports = {};
__export(grok_exports, {
  GROK_MAX_SCHEMA_ARGUMENT_BYTES: () => GROK_MAX_SCHEMA_ARGUMENT_BYTES,
  GrokAcpProtocolError: () => GrokAcpProtocolError,
  describeGrokStructuredError: () => describeGrokStructuredError,
  grokAcpArguments: () => grokAcpArguments,
  grokAcpProbeArguments: () => grokAcpProbeArguments,
  grokCompletedTerminalEvidence: () => grokCompletedTerminalEvidence,
  grokInvocationEnvironment: () => grokInvocationEnvironment,
  grokInvocationFlags: () => grokInvocationFlags,
  grokNativeModel: () => grokNativeModel,
  grokSettledOutputMatches: () => grokSettledOutputMatches,
  grokStderrHasQuotaExhaustion: () => grokStderrHasQuotaExhaustion,
  grokStreamingArguments: () => grokStreamingArguments,
  grokSupportsAcp: () => grokSupportsAcp,
  grokSupportsStreamingSchema: () => grokSupportsStreamingSchema,
  grokTerminalCompleted: () => grokTerminalCompleted,
  inspectGrokStructuredCli: () => inspectGrokStructuredCli,
  observeGrokNativeAcp: () => observeGrokNativeAcp,
  observeGrokNativeStderr: () => observeGrokNativeStderr,
  observeGrokNativeStreaming: () => observeGrokNativeStreaming,
  observeGrokStructured: () => observeGrokStructured
});
import { createHash as createHash4 } from "node:crypto";
import { createInterface as createInterface3 } from "node:readline";
import { finished } from "node:stream/promises";
function grokNativeModel(value) {
  if (!value.trim() || value.includes("\0"))
    throw Object.assign(new Error("Grok Build requires grok:<model> or grok:default"), { code: "unsupported" });
  return value === "default" ? void 0 : value;
}
function grokTerminalCompleted(terminal) {
  return terminal?.stopReason === "end_turn";
}
function grokCompletedTerminalEvidence(terminal) {
  return grokTerminalCompleted(terminal) && Array.isArray(terminal.models) && terminal.models.length > 0 && terminal.models.every((model) => typeof model === "string" && !!model.trim());
}
function grokSettledOutputMatches(output, request) {
  const terminal = output?.terminal;
  if (!terminal || terminal.sessionId !== request.sessionId || terminal.cwd !== request.cwd || typeof terminal.requestId !== "string" || !terminal.requestId.trim() || request.promptId !== void 0 && terminal.requestId !== request.promptId || !grokCompletedTerminalEvidence(terminal) || typeof output?.text !== "string") return false;
  return request.nativeSchema ? output.structuredOutput === "present" || output.structuredOutput === "missing" : output.structuredOutput === void 0;
}
function describeGrokStructuredError(error, useAcp) {
  if (!(error instanceof GrokAcpProtocolError)) return void 0;
  const finishInput = error.code === "missing_startup_terminal";
  const missingTerminal = finishInput || !useAcp && error.code === "missing_terminal";
  return {
    message: missingTerminal ? "Grok native stream closed without its original terminal" : error.message,
    missingTerminal,
    finishInput
  };
}
function grokAcpProbeArguments() {
  return ["--no-auto-update", "agent", "--help"];
}
function grokSupportsAcp(help) {
  return /^[\t ]+stdio[\t ]/m.test(help) && /^[\t ]+--no-leader(?:[\t ]|\r?$)/m.test(help);
}
function grokSupportsStreamingSchema(help) {
  return /^[\t ]*--json-schema(?:[\t ]|\r?$)/m.test(help);
}
function inspectGrokStructuredCli({ command, args, cwd }, mode, schemaArgument) {
  const launch = { command, args, cwd };
  const probe = (flags) => runNativeCliProbe(launch, flags);
  const version = probe(["--version"]);
  const cliVersion = version.stdout?.trim();
  if (version.status !== 0 || !cliVersion) return void 0;
  const schemaHelp = Buffer.byteLength(schemaArgument) <= GROK_MAX_SCHEMA_ARGUMENT_BYTES ? probe(["--help"]) : void 0;
  const acpHelp = mode === "edit" ? probe(grokAcpProbeArguments()) : void 0;
  const useAcp = acpHelp?.status === 0 && grokSupportsAcp(acpHelp.stdout);
  return {
    cliVersion,
    useAcp,
    nativeSchema: useAcp || schemaHelp?.status === 0 && grokSupportsStreamingSchema(schemaHelp.stdout)
  };
}
function grokAcpArguments() {
  return ["--no-auto-update", "--permission-mode", "bypassPermissions", "agent", "--no-leader", "stdio"];
}
function grokStreamingArguments({ cwd, sessionId, promptFile, mode, model, schemaArgument }) {
  return [
    "--cwd",
    cwd,
    "--session-id",
    sessionId,
    "--prompt-file",
    promptFile,
    "--output-format",
    "streaming-json",
    ...mode === "read" ? ["--permission-mode", "plan", "--disallowed-tools", "enter_plan_mode,exit_plan_mode"] : ["--permission-mode", "bypassPermissions"],
    ...model === void 0 ? [] : ["--model", model],
    ...schemaArgument === void 0 ? [] : ["--json-schema", schemaArgument]
  ];
}
function grokInvocationEnvironment(environment, useAcp) {
  return {
    ...environment,
    GROK_MCP_AUTO_RESTART: "0",
    ...useAcp ? {} : { GROK_TELEMETRY_TRACE_UPLOAD: "false" }
  };
}
function grokInvocationFlags(args, useAcp) {
  return new Set(useAcp ? [args[0], args[1], args[4]] : args.filter((_, index) => index % 2 === 0));
}
function object4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (
    /** @type {RpcObject} */
    value
  ) : void 0;
}
async function* acpFrames(stdout) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const pieces = [];
  try {
    for await (const chunk of stdout.iterator({ destroyOnReturn: false })) {
      const lines = decoder.decode(chunk, { stream: true }).split("\n");
      for (const line of lines.slice(0, -1)) {
        pieces.push(line);
        const packet = object4(JSON.parse(pieces.join("")));
        pieces.length = 0;
        if (packet?.jsonrpc !== "2.0") throw new GrokAcpProtocolError("Grok ACP stream has an invalid JSON-RPC envelope");
        yield packet;
      }
      const tail = lines.at(-1);
      if (tail) pieces.push(tail);
    }
    if (decoder.decode() || pieces.length) throw new GrokAcpProtocolError("Grok ACP stream has an incomplete frame");
  } catch (error) {
    if (error instanceof GrokAcpProtocolError) throw error;
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new GrokAcpProtocolError("Grok ACP stream has an invalid JSON frame");
    throw new GrokAcpProtocolError("Grok ACP stdout could not be read", "transport_error");
  }
}
function promptResult(result, identity, chunks) {
  const meta = object4(result._meta);
  const stopReason = result.stopReason;
  if (meta?.sessionId !== identity.sessionId || meta.requestId !== identity.requestId || meta.promptId !== void 0 && meta.promptId !== identity.requestId || typeof stopReason !== "string" || !stopReasons.has(stopReason))
    throw new GrokAcpProtocolError("Grok ACP terminal differs from its original session or prompt");
  const usage = object4(meta.usage);
  const modelUsage = object4(usage?.modelUsage);
  const modelEntries = Object.entries(modelUsage ?? {});
  if (meta.usage !== void 0 && !usage || usage?.modelUsage !== void 0 && !modelUsage || grokTerminalCompleted({ stopReason }) && !modelEntries.length || modelEntries.some(([model, value]) => !/^[a-z\d][a-z\d._:/-]*$/i.test(model) || !object4(value)))
    throw new GrokAcpProtocolError("Grok ACP terminal lacks valid actual model usage");
  const hasStructuredOutput = Object.hasOwn(meta, "structuredOutput");
  return {
    ...identity,
    kind: "result",
    stopReason,
    models: modelEntries.map(([model]) => model),
    text: hasStructuredOutput ? "" : chunks.join(""),
    ...hasStructuredOutput ? { structuredOutput: meta.structuredOutput } : {}
  };
}
async function observeGrokNativeAcp(stdout, stdin, request, onTerminal) {
  const { sessionId, promptId, cwd, prompt, schema, model } = request;
  const identity = { sessionId, requestId: promptId, cwd };
  const chunks = [];
  const nestedQueueSessions = /* @__PURE__ */ new Set();
  let terminal;
  let awaiting = "initialize";
  const send = (packet) => new Promise((resolve2, reject) => {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", ...packet }) + "\n", (error) => {
      if (error) reject(new GrokAcpProtocolError("Grok ACP stdin could not be written", "transport_error"));
      else resolve2();
    });
  });
  const sendRequest = (method, params) => send({ id: requestIds[method], method, params });
  const inputClosed = finished(stdin, { readable: false, cleanup: true }).then(() => true, () => false);
  await sendRequest("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  for await (const packet of acpFrames(stdout)) {
    if (terminal) throw new GrokAcpProtocolError("Grok ACP stream has data after its original prompt terminal");
    const { method, id } = packet;
    const params = object4(packet.params);
    const hasResult = Object.hasOwn(packet, "result"), hasError = Object.hasOwn(packet, "error");
    if (Object.hasOwn(packet, "method")) {
      if (typeof method !== "string" || !method || hasResult || hasError || Object.hasOwn(packet, "params") && !params)
        throw new GrokAcpProtocolError("Grok ACP agent sent an invalid request or notification");
      if (Object.hasOwn(packet, "id")) {
        if (method === "session/update" || typeof id !== "string" && !Number.isSafeInteger(id))
          throw new GrokAcpProtocolError("Grok ACP agent sent an invalid request ID");
        if (method === "session/request_permission") {
          if (awaiting !== "session/prompt" || params?.sessionId !== sessionId)
            throw new GrokAcpProtocolError("Grok ACP permission request differs from its original session");
          await send({ id, result: { outcome: { outcome: "cancelled" } } });
        } else await send({ id, error: { code: -32601, message: "Client method unavailable" } });
      } else if (method === "session/update") {
        const update = object4(params?.update), updateMeta = object4(params?._meta);
        const kind = update?.sessionUpdate, updateSession = params?.sessionId;
        if (typeof kind !== "string" || !kind || params?._meta !== void 0 && !updateMeta)
          throw new GrokAcpProtocolError("Grok ACP update differs from its original session or prompt");
        if (awaiting === "session/prompt" && typeof updateSession === "string" && nestedQueueSessions.has(updateSession)) continue;
        if (updateSession !== sessionId || updateMeta?.promptId !== void 0 && updateMeta.promptId !== promptId || awaiting !== "session/prompt" && (awaiting !== "session/new" || kind !== "available_commands_update"))
          throw new GrokAcpProtocolError("Grok ACP update differs from its original session or prompt");
        if (kind === "tool_call" || kind === "tool_call_update") chunks.length = 0;
        if (kind === "agent_message_chunk") {
          const content = object4(update?.content);
          if (typeof content?.type !== "string") throw new GrokAcpProtocolError("Grok ACP agent sent an invalid assistant message chunk");
          if (content.type === "text") {
            if (typeof content.text !== "string") throw new GrokAcpProtocolError("Grok ACP agent sent an invalid assistant message chunk");
            chunks.push(content.text);
          }
        }
      } else {
        const notificationSession = params?.sessionId;
        if (method === "_x.ai/queue/changed" && awaiting === "session/prompt" && typeof notificationSession === "string" && notificationSession && Array.isArray(params?.entries)) {
          if (notificationSession !== sessionId) nestedQueueSessions.add(notificationSession);
        } else if (!method.startsWith("_x.ai/") || notificationSession != null && notificationSession !== sessionId && !(typeof notificationSession === "string" && nestedQueueSessions.has(notificationSession))) {
          throw new GrokAcpProtocolError("Grok ACP agent sent an unexpected notification");
        }
      }
      continue;
    }
    if (id !== requestIds[awaiting] || hasResult === hasError || Object.hasOwn(packet, "params"))
      throw new GrokAcpProtocolError("Grok ACP response differs from its outstanding request");
    if (hasError) {
      const error = object4(packet.error);
      if (!Number.isSafeInteger(error?.code) || typeof error?.message !== "string")
        throw new GrokAcpProtocolError("Grok ACP agent returned an invalid RPC error");
      if (awaiting !== "session/prompt") throw new GrokAcpProtocolError(`Grok ACP ${awaiting} was rejected`);
      terminal = error.code === -32003 && error.message === "Rate limited" ? { ...identity, kind: "rate_limited", rpcCode: -32003, message: "Rate limited" } : { ...identity, kind: "prompt_error" };
    } else {
      const result = object4(packet.result);
      if (!result) throw new GrokAcpProtocolError("Grok ACP agent returned an invalid RPC result");
      if (awaiting === "initialize") {
        const offered = Array.isArray(result.authMethods) ? result.authMethods.map((method2) => object4(method2)?.id) : [];
        const methodId = ["cached_token", "xai.api_key"].find((method2) => offered.includes(method2));
        if (result.protocolVersion !== 1 || !methodId)
          throw new GrokAcpProtocolError("Grok ACP agent did not advertise protocol v1 with local noninteractive authentication");
        awaiting = "authenticate";
        await sendRequest(awaiting, { methodId, _meta: { headless: true } });
      } else if (awaiting === "authenticate") {
        awaiting = "session/new";
        await sendRequest(awaiting, { cwd, mcpServers: [], _meta: { sessionId, ...model === void 0 ? {} : { modelId: model } } });
      } else if (awaiting === "session/new") {
        if (result.sessionId !== sessionId || object4(result._meta)?.currentWorkingDirectory !== cwd)
          throw new GrokAcpProtocolError("Grok ACP opened a different session or worktree");
        awaiting = "session/prompt";
        await sendRequest(awaiting, { sessionId, prompt: [{ type: "text", text: prompt }], _meta: { promptId, outputSchema: schema } });
      } else terminal = promptResult(result, identity, chunks);
    }
    if (terminal) {
      stdin.end();
      onTerminal(terminal);
    }
  }
  if (!terminal) throw new GrokAcpProtocolError("Grok ACP stream closed without its original terminal", awaiting === "initialize" ? "missing_startup_terminal" : "missing_terminal");
  if (!stdout.readableEnded || !await inputClosed) throw new GrokAcpProtocolError("Grok ACP transport did not finish cleanly", "transport_error");
  return terminal;
}
async function* streamingLines(stdout) {
  const lines = createInterface3({ input: stdout, crlfDelay: Infinity });
  const close = () => lines.close();
  stdout.once("close", close);
  try {
    yield* lines;
  } catch {
    throw new GrokAcpProtocolError("Grok native stdout could not be read", "transport_error");
  } finally {
    stdout.off("close", close);
    lines.close();
  }
}
async function observeGrokNativeStreaming(stdout, { sessionId, cwd, nativeSchema }, onTerminal) {
  const chunks = [];
  let terminal;
  let structuredOutput;
  for await (const line of streamingLines(stdout)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = object4(JSON.parse(line));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new GrokAcpProtocolError("Grok native event is not valid JSON");
    }
    if (terminal || typeof event?.type !== "string") throw new GrokAcpProtocolError("Grok native stream has an invalid event or data after its terminal");
    if (event.type === "tool_call" || event.type === "tool_call_update") chunks.length = 0;
    else if (event.type === "text") {
      if (typeof event.data !== "string") throw new GrokAcpProtocolError("Grok native text event has an invalid shape");
      chunks.push(event.data);
    } else if (event.type === "end") {
      const { requestId, stopReason } = event;
      const models2 = Object.keys(object4(event.modelUsage) ?? {});
      if (event.sessionId !== sessionId || event.cwd !== cwd || typeof requestId !== "string" || !requestId.trim() || typeof stopReason !== "string" || !stopReason || models2.some((model) => !model.trim()) || grokTerminalCompleted({ stopReason }) && !models2.length)
        throw new GrokAcpProtocolError("Grok native terminal lacks the original session, worktree, request or actual model identity");
      terminal = { sessionId, requestId, cwd, stopReason, models: models2 };
      if (nativeSchema && Object.hasOwn(event, "structuredOutput")) structuredOutput = JSON.stringify(event.structuredOutput);
      onTerminal(terminal);
    }
  }
  if (!stdout.readableEnded) throw new GrokAcpProtocolError("Grok native stdout did not reach EOF", "transport_error");
  if (!terminal) throw new GrokAcpProtocolError("Grok native stream closed without its original terminal", "missing_terminal");
  return {
    terminal,
    text: structuredOutput ?? chunks.join(""),
    ...nativeSchema ? { structuredOutput: structuredOutput === void 0 ? "missing" : "present" } : {}
  };
}
async function observeGrokStructured({ stdout, stdin, sessionId, cwd, nativeSchema, acp }, onTerminal) {
  if (!acp) {
    const output = await observeGrokNativeStreaming(stdout, { sessionId, cwd, nativeSchema }, onTerminal);
    return { output };
  }
  const native = await observeGrokNativeAcp(stdout, stdin, { ...acp, sessionId, cwd }, (value) => onTerminal(value.kind === "result" ? value : void 0));
  if (native.kind !== "result") return { failure: native };
  const { requestId, stopReason, models: models2 } = native;
  const terminal = { sessionId, requestId, cwd, stopReason, models: models2 };
  const hasNativeOutput = Object.hasOwn(native, "structuredOutput");
  return {
    output: {
      terminal,
      text: hasNativeOutput ? JSON.stringify(native.structuredOutput) : native.text,
      structuredOutput: hasNativeOutput ? "present" : "missing"
    }
  };
}
function nativeHttpStatus(text2) {
  const prefix = /^(?:error:[ \t]*)?HTTP(?:\/[1-3](?:\.[01])?)?[ \t]+/i.exec(text2);
  if (!prefix) return null;
  let value = text2.slice(prefix[0].length);
  const label = /^(?:status(?: code)?|error)([ \t]*)([:=]?)/i.exec(value);
  if (label) {
    value = value.slice(label[0].length);
    if (label[2]) {
      const gap = /^[ \t]+/.exec(value);
      if (!gap) return null;
      value = value.slice(gap[0].length);
    } else if (!label[1]) return null;
  }
  const status = /^[45]\d{2}(?=[ \t:]|$)/.exec(value);
  return status ? { code: Number(status[0]), message: value.slice(status[0].length) } : null;
}
function observeGrokNativeStderr(stderr, flags) {
  const hash = createHash4("sha256"), line = Buffer.alloc(4096);
  const httpStatuses = /* @__PURE__ */ new Set();
  const startupErrors = /* @__PURE__ */ new Map();
  let bytes = 0, lineBytes = 0, discardLine = false, oversizedLine = false, usageBalanceExhausted = false, readError = false;
  const finishLine = () => {
    if (!discardLine) {
      const startupLine = line.toString("utf8", 0, lineBytes).replace(/\r$/, ""), text2 = startupLine.trim();
      const argument = /^error: unexpected argument '(--[a-z][a-z-]*)' found$/.exec(startupLine);
      if (argument && argument[0] === startupLine && flags.has(argument[1])) startupErrors.set(argument[1], { kind: "unexpected_argument", flag: argument[1] });
      const errno = startupLine === "Error: No such file or directory (os error 2)" ? "ENOENT" : startupLine === "Error: Permission denied (os error 13)" ? "EACCES" : void 0;
      if (errno) startupErrors.set(errno, { kind: "os_error", errno });
      const status = nativeHttpStatus(text2);
      if (status) httpStatuses.add(status.code);
      const body = (status?.message ?? text2.replace(/^error:[ \t]*/i, "")).trimStart();
      const message = body.startsWith(":") ? body.slice(1).trimStart() : body;
      if (/^(?:usage balance exhausted|you hit your weekly limit)[.!]?$/i.test(message)) usageBalanceExhausted = true;
    }
    lineBytes = 0;
    discardLine = false;
  };
  stderr.on("data", (chunk) => {
    bytes += chunk.length;
    hash.update(chunk);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
      if (end - start > line.length - lineBytes) discardLine = oversizedLine = true;
      if (!discardLine) lineBytes += chunk.copy(line, lineBytes, start, end);
      if (newline < 0) break;
      finishLine();
      start = newline + 1;
    }
  });
  stderr.once("end", finishLine);
  stderr.once("error", () => {
    readError = true;
  });
  return () => ({
    bytes,
    sha256: hash.copy().digest("hex"),
    ended: stderr.readableEnded,
    oversizedLine,
    readError,
    httpStatuses: [...httpStatuses].sort((a, b) => a - b),
    usageBalanceExhausted,
    ...startupErrors.size ? { startupErrors: [...startupErrors.values()] } : {}
  });
}
function grokStderrHasQuotaExhaustion({ ended, readError, oversizedLine, usageBalanceExhausted, httpStatuses }) {
  return ended && !readError && !oversizedLine && (usageBalanceExhausted || httpStatuses.includes(429));
}
var GROK_MAX_SCHEMA_ARGUMENT_BYTES, GrokAcpProtocolError, requestIds, stopReasons;
var init_grok = __esm({
  "src/llm_manager/native/grok.mjs"() {
    init_cli_probe();
    GROK_MAX_SCHEMA_ARGUMENT_BYTES = 64 * 1024;
    GrokAcpProtocolError = class extends Error {
      /** @param {string} message @param {GrokProtocolErrorCode} code */
      constructor(message, code = "invalid_protocol") {
        super(message);
        this.code = code;
      }
    };
    requestIds = Object.freeze({ initialize: 1, authenticate: 2, "session/new": 3, "session/prompt": 4 });
    stopReasons = /* @__PURE__ */ new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);
  }
});

// src/llm_manager/native/zcode.mjs
var zcode_exports = {};
__export(zcode_exports, {
  ZCodeNativeTurnFailedError: () => ZCodeNativeTurnFailedError,
  ZCodeProtocolError: () => ZCodeProtocolError,
  assertZCodeMcpRequestContext: () => assertZCodeMcpRequestContext,
  assertZCodeModelSnapshot: () => assertZCodeModelSnapshot,
  decodeZCodeJsonText: () => decodeZCodeJsonText,
  decodeZCodeStructuredText: () => decodeZCodeStructuredText,
  inspectZCodeCliVersion: () => inspectZCodeCliVersion,
  isZCodeEventsRpcTimeout: () => isZCodeEventsRpcTimeout,
  isZCodeEventsTimeout: () => isZCodeEventsTimeout,
  isZCodeProviderPipeFailure: () => isZCodeProviderPipeFailure,
  isZCodeProviderRejection: () => isZCodeProviderRejection,
  isZCodePublicHttp429: () => isZCodePublicHttp429,
  nativeRpcTimeoutMessage: () => nativeRpcTimeoutMessage,
  observeZCodeFrozenReadTurn: () => observeZCodeFrozenReadTurn,
  zcodeAppServerArgs: () => zcodeAppServerArgs,
  zcodeAssertSendAck: () => zcodeAssertSendAck,
  zcodeCapability: () => zcodeCapability,
  zcodeCreateInput: () => zcodeCreateInput,
  zcodeEventCollector: () => zcodeEventCollector,
  zcodeIdleObservation: () => zcodeIdleObservation,
  zcodeIsTerminal: () => zcodeIsTerminal,
  zcodeMcpClientMatches: () => zcodeMcpClientMatches,
  zcodeMessages: () => zcodeMessages,
  zcodeNativeConfigModel: () => zcodeNativeConfigModel,
  zcodeNativeConfigSelection: () => zcodeNativeConfigSelection,
  zcodeNativeIdentity: () => zcodeNativeIdentity,
  zcodeNativeModel: () => zcodeNativeModel,
  zcodeNativeSelection: () => zcodeNativeSelection,
  zcodePermissionScope: () => zcodePermissionScope,
  zcodePlanModelMatches: () => zcodePlanModelMatches,
  zcodeProofEvent: () => zcodeProofEvent,
  zcodeProtocolLine: () => zcodeProtocolLine,
  zcodeProviderUsage: () => zcodeProviderUsage,
  zcodeReplayTerminal: () => zcodeReplayTerminal,
  zcodeRequireSession: () => zcodeRequireSession,
  zcodeRpc: () => zcodeRpc,
  zcodeRuntimeConfiguration: () => zcodeRuntimeConfiguration,
  zcodeRuntimeEnv: () => zcodeRuntimeEnv,
  zcodeRuntimeFiles: () => zcodeRuntimeFiles,
  zcodeSelectSessionModel: () => zcodeSelectSessionModel,
  zcodeSendInput: () => zcodeSendInput,
  zcodeSuccessfulTerminal: () => zcodeSuccessfulTerminal,
  zcodeTerminalFailure: () => zcodeTerminalFailure,
  zcodeVersionArgs: () => zcodeVersionArgs,
  zcodeWorktreeConfiguration: () => zcodeWorktreeConfiguration,
  zcodeWorktreeResponse: () => zcodeWorktreeResponse,
  zcodeWorktreeTurnMatches: () => zcodeWorktreeTurnMatches
});
import { randomUUID as randomUUID2 } from "node:crypto";
import { constants as constants2 } from "node:os";
import { join as join3 } from "node:path";
import { isDeepStrictEqual } from "node:util";
function isZCodeProviderRejection(failure) {
  return failure?.code === "unsupported" && failure.message === providerRejection;
}
function isZCodeProviderPipeFailure(nativeCode, nativeAttribution) {
  const attribution = (
    /** @type {NativeFailure['attribution']} */
    nativeAttribution
  );
  return nativeCode === "EPIPE" && attribution?.source === "provider" && attribution.exceptionKind === "provider_business" && attribution.retryable === false;
}
function isZCodePublicHttp429(error) {
  const status = (
    /** @type {NativeFailure | undefined} */
    error?.attribution?.statusCode
  );
  return status === 429 || status === "429";
}
function zcodeTerminalFailure(terminal, worktree, managed) {
  if (terminal?.type !== "turn.failed" || !terminal.turnId) return void 0;
  const error = (
    /** @type {NativeFailure | undefined} */
    terminal.payload.error
  );
  return new ZCodeNativeTurnFailedError(
    terminal.sessionId,
    terminal.turnId,
    error?.code,
    worktree,
    error?.attribution,
    worktree && managed && isZCodePublicHttp429(error)
  );
}
function zcodeReplayTerminal(terminal) {
  if (terminal.type === "turn.failed") {
    const error = (
      /** @type {NativeFailure | undefined} */
      terminal.payload.error
    );
    return {
      kind: "failed",
      pipeFailure: error?.code === "EPIPE",
      providerInputRejection: terminal.payload.turnPhase === "processing_input" && isZCodeProviderPipeFailure(error?.code, error?.attribution),
      publicHttp429: isZCodePublicHttp429(error)
    };
  }
  if (terminal.type === "turn.completed") {
    const { resultType, response } = terminal.payload;
    return {
      kind: "completed",
      result: resultType === "success" || resultType === "cancelled" ? resultType : "other",
      hasResponse: typeof response === "string"
    };
  }
  return { kind: "other" };
}
function isZCodeEventsRpcTimeout(execution) {
  return execution.state === "failed" && execution.errorCode === "native_rpc_timeout" && execution.error === nativeRpcTimeoutMessage("session/events");
}
function isZCodeEventsTimeout(error) {
  return error instanceof Error && "code" in error && error.code === "native_rpc_timeout" && error.message === nativeRpcTimeoutMessage("session/events");
}
function zcodeNativeModel(model) {
  const match = /^zcode:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(model ?? "");
  if (!match || ["default", "auto", "latest", "fast", "smart"].includes(match[2].toLowerCase())) {
    throw new ZCodeProtocolError("unsupported", "ZCode execution requires zcode:<provider-id>/<exact-model-id>");
  }
  return { providerId: match[1], modelId: match[2] };
}
function zcodeNativeSelection(model, effort) {
  const native = zcodeNativeModel(model);
  if (effort === void 0) return { model: native };
  if (effort !== "high" || native.providerId !== "bigmodel-api" || native.modelId !== "GLM-5.3-Flash") {
    throw new ZCodeProtocolError("unsupported", "ZCode effort requires the verified bigmodel-api/GLM-5.3-Flash high mapping");
  }
  return { model: { ...native, options: { reasoningLevel: "high" } }, thoughtLevel: "high" };
}
function zcodeNativeConfigModel(model, resolvedModel) {
  const value = model?.startsWith("zcode:") ? resolvedModel ?? model.slice("zcode:".length) : "";
  if (value === "default") return void 0;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new ZCodeProtocolError("unsupported", "ZCode native configuration requires zcode:default or zcode:<provider>/<model>");
  }
  return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
}
function zcodeNativeConfigSelection(model, effort, resolvedModel) {
  const selected = zcodeNativeConfigModel(model, resolvedModel);
  return {
    ...selected ? { model: effort ? { ...selected, options: { reasoningLevel: effort } } : selected } : {},
    ...effort ? { thoughtLevel: effort } : {}
  };
}
function zcodePlanModelMatches(plan, requested, { generic, sent }) {
  if (!generic) {
    return isDeepStrictEqual({ model: plan.model, ...plan.thoughtLevel ? { thoughtLevel: plan.thoughtLevel } : {} }, requested);
  }
  return (!requested.model || plan.model?.providerId === requested.model.providerId && plan.model.modelId === requested.model.modelId && Object.entries(requested.model.options ?? {}).every(([key, value]) => isDeepStrictEqual(plan.model?.options?.[key], value))) && (!requested.thoughtLevel || plan.thoughtLevel === requested.thoughtLevel) && (!sent || !!plan.model);
}
function assertZCodeModelSnapshot(snapshot, expected, generic = false) {
  const displayed = snapshot.session?.model;
  const current = snapshot.settings?.model?.current;
  const thought = snapshot.settings?.thoughtLevel;
  if (generic) {
    for (const model of [displayed, current]) {
      if (!model || expected.model && (model.providerId !== expected.model.providerId || model.modelId !== expected.model.modelId)) {
        throw new ZCodeProtocolError("unsupported", "ZCode actual session model differs from the requested model");
      }
    }
    for (const [key, value] of Object.entries(expected.model?.options ?? {})) {
      if (!isDeepStrictEqual(current?.options?.[key], value)) throw new ZCodeProtocolError("unsupported", `ZCode actual session model option ${key} differs from the request`);
    }
    if (expected.thoughtLevel && (current?.options?.reasoningLevel !== expected.thoughtLevel || thought?.current !== expected.thoughtLevel || !Array.isArray(thought.available) || !thought.available.some((level) => level.value === expected.thoughtLevel))) {
      throw new ZCodeProtocolError("unsupported", "ZCode actual snapshot did not select the requested effort");
    }
    return;
  }
  for (const model of [displayed, current]) {
    if (!model || !expected.model || model.providerId !== expected.model.providerId || model.modelId !== expected.model.modelId || Object.keys(model).some((key) => !["providerId", "modelId", "options"].includes(key)) || model.options && (Object.keys(model.options).some((key) => key !== "reasoningLevel") || typeof model.options.reasoningLevel !== "string")) {
      throw new ZCodeProtocolError("unsupported", "ZCode actual session model or native options differ");
    }
  }
  if (expected.thoughtLevel && (current?.options?.reasoningLevel !== expected.thoughtLevel || thought?.current !== expected.thoughtLevel || !Array.isArray(thought.available) || !thought.available.some((level) => level.value === expected.thoughtLevel) || displayed?.options?.reasoningLevel !== void 0 && displayed.options.reasoningLevel !== expected.thoughtLevel)) {
    throw new ZCodeProtocolError("unsupported", "ZCode actual snapshot did not select the requested high effort");
  }
}
function zcodeRequireSession(created, sessionId) {
  const session = created?.session ?? created?.snapshot?.session;
  if (session?.sessionId !== sessionId) throw new ZCodeProtocolError("stale_result", "ZCode actual session identity differs");
  return session;
}
function zcodeSelectSessionModel(session, snapshot, selection, generic) {
  if (snapshot?.session?.sessionId !== session.sessionId) throw new ZCodeProtocolError("stale_result", "ZCode model snapshot belongs to another session");
  const current = snapshot.settings?.model?.current;
  if (generic && (typeof current?.providerId !== "string" || !current.providerId || typeof current.modelId !== "string" || !current.modelId)) {
    throw new ZCodeProtocolError("unsupported", "ZCode SDK did not expose its selected model");
  }
  const checkedSelection = generic && !selection.model && current ? { ...selection, model: { providerId: current.providerId, modelId: current.modelId } } : selection;
  assertZCodeModelSnapshot({ session, settings: snapshot.settings }, checkedSelection, generic);
  assertZCodeModelSnapshot(snapshot, checkedSelection, generic);
  const model = (
    /** @type {NativeModel} */
    current
  );
  return {
    selection: generic ? { ...selection, model } : selection,
    modelSnapshot: { sessionId: session.sessionId, model, thoughtLevel: snapshot.settings?.thoughtLevel?.current }
  };
}
function zcodeAssertSendAck(ack, sessionId) {
  if (ack?.accepted !== true || ack.sessionId !== sessionId) throw new ZCodeProtocolError("stale_result", "ZCode send ACK has no exact accepted session");
}
function zcodeMessages(history) {
  if (!Array.isArray(history?.messages) || history.hasMore === true) throw new ZCodeProtocolError("stale_result", "ZCode raw native history is incomplete");
  return (
    /** @type {NativeMessage[]} */
    history.messages
  );
}
function inspectZCodeCliVersion(launch, nativeConfiguration) {
  const version = runNativeCliProbe(launch, zcodeVersionArgs());
  const cliVersion = version.stdout?.trim();
  if (version.error || version.status !== 0 || !cliVersion || !nativeConfiguration && cliVersion !== zcodeCapability.cliVersion) {
    throw new ZCodeProtocolError("unsupported", "ZCode CLI version could not be recorded for this runtime");
  }
  return cliVersion;
}
function zcodeRuntimeFiles(home, hostHome) {
  return {
    config: join3(home, ".zcode", "cli", "config.json"),
    credentialSource: join3(hostHome, ".zcode", "v2", "credentials.json"),
    credentialLink: join3(home, ".zcode", "v2", "credentials.json"),
    personal: join3(hostHome, ".zcode", "v2", "provider_config.json")
  };
}
function zcodeRuntimeEnv({ path, home, tmp, personal }) {
  return {
    PATH: path,
    HOME: home,
    TMPDIR: `${tmp}/`,
    ZCODE_DATA_BASE_DIR: home,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeCapability.builtinPath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal
  };
}
function zcodeRuntimeConfiguration() {
  return {
    features: { mcp: true, subagent: false, memory: false, skill: false },
    mcp: { servers: {} },
    plugins: { enabled: false, dirs: [], enabledPlugins: {}, extraKnownMarketplaces: {}, options: {}, suppressedBuiltins: [] },
    hooks: { enabled: false, events: {} },
    skills: { enabled: false, includeInstructions: false, roots: [] }
  };
}
function zcodeWorktreeConfiguration() {
  return { ...zcodeRuntimeConfiguration(), features: { mcp: false, subagent: false, memory: false, skill: false } };
}
function zcodePermissionScope(request, sessionId) {
  if (request.sessionId !== sessionId) return void 0;
  if (["Read", "Glob", "Grep", "Bash"].includes(request.toolName ?? "")) return { access: "read" };
  if (["Edit", "Write", "NotebookEdit"].includes(request.toolName ?? "")) {
    const path = request.input?.file_path ?? request.input?.path;
    if (typeof path === "string") return { access: "edit", path };
  }
  return void 0;
}
function zcodeCreateInput({ sessionId, workspace, selection, mode, frozenReader }) {
  return {
    sessionId,
    workspace: { workspacePath: workspace, workspaceKey: workspace },
    ...selection,
    mode: mode === "edit" && !frozenReader ? "build" : "plan",
    persistence: "immediate",
    titleGenerationEnabled: false,
    ...frozenReader ? {
      mcpServers: [{
        name: "frozen",
        command: frozenReader.command,
        args: frozenReader.args,
        env: [],
        cwd: workspace,
        isolation: "session",
        protocolVersion: "legacy",
        alwaysLoad: true
      }],
      toolAllowlist: [zcodeCapability.tool],
      toolDenylist: ["Bash", "Read", "Edit", "Write", "Task", "WebSearch", "WebFetch"]
    } : { mcpServers: [] }
  };
}
function zcodeSendInput(plan, content) {
  return {
    sessionId: plan.sessionId,
    content,
    inputId: plan.inputId,
    modelSelection: (
      /** @type {NativeModel} */
      plan.model
    ),
    ...plan.version >= 2 ? { toolDenylist: plan.toolDenylist } : {}
  };
}
function zcodeProtocolLine(packet) {
  return `${JSON.stringify(packet).replace(/[\u0080-\uffff]/g, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"))}
`;
}
function zcodeRpc(transport, { sessionId, permission, onProtocolError, isEnded, timeoutMs = 1e4 }) {
  const pending = /* @__PURE__ */ new Map();
  let nextId = 0;
  let closed = false;
  const request = (method, params) => new Promise((resolve2, reject) => {
    if (closed || isEnded?.() || !transport.isWritable()) {
      reject(new ZCodeProtocolError("cancellation_pending", "ZCode native transport ended before exact settlement"));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new ZCodeProtocolError("native_rpc_timeout", nativeRpcTimeoutMessage(method)));
    }, timeoutMs);
    pending.set(id, { resolve: resolve2, reject, timer });
    try {
      transport.write(zcodeProtocolLine({ id, method, params }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
  const unsubscribe = transport.subscribe((line) => {
    let packet;
    try {
      packet = JSON.parse(line);
    } catch {
      onProtocolError(new ZCodeProtocolError("failed", "ZCode emitted non-JSON native protocol"));
      return;
    }
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
      onProtocolError(new ZCodeProtocolError("failed", "ZCode emitted invalid native protocol"));
      return;
    }
    if (packet.method && packet.id !== void 0) {
      const { id, method, params } = packet;
      if (method === "session/requestRuntimePreferences" && params?.sessionId === sessionId) {
        transport.write(zcodeProtocolLine({ id, result: {
          nativeSearchEnhancementsEnabled: false,
          toolSearchMode: "off",
          subagentRuntimeConfigEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: false,
          additionalDirectories: [],
          modelContextBudgetStrategy: "preflight-v1"
        } }));
      } else if (method === "interaction/requestPermission" && params?.sessionId === sessionId && permission) {
        const decision = permission(params);
        transport.write(zcodeProtocolLine({ id, result: { decision, reason: decision === "allow" ? "Task-authorized native worktree invocation" : "Outside this native worktree task" } }));
      } else {
        transport.write(zcodeProtocolLine({ id, error: { code: -32601, message: "Unavailable in frozen read-only runtime" } }));
      }
      return;
    }
    if (typeof packet.id !== "number") return;
    const waiter = pending.get(packet.id);
    if (!waiter) return;
    pending.delete(packet.id);
    clearTimeout(waiter.timer);
    if (packet.error) waiter.reject(new ZCodeProtocolError("failed", `ZCode native RPC rejected (code ${typeof packet.error.code === "number" ? packet.error.code : "unknown"})`));
    else waiter.resolve(packet.result);
  });
  const read = () => request("session/read", { sessionId });
  return {
    request,
    /** @param {ReturnType<typeof zcodeCreateInput>} input */
    async create(input) {
      return (
        /** @type {Parameters<typeof zcodeRequireSession>[0]} */
        await request("session/create", input)
      );
    },
    async readModel() {
      return (
        /** @type {ModelSnapshot} */
        await read()
      );
    },
    /** @param {ReturnType<typeof zcodeSendInput>} input @param {string} queryId */
    async send(input, queryId) {
      return (
        /** @type {Parameters<typeof zcodeAssertSendAck>[0]} */
        await request("session/send", { ...input, queryId })
      );
    },
    /** @param {number} [cursor] */
    async events(cursor) {
      return (
        /** @type {{events?: NativeEvent[]}} */
        await request("session/events", { sessionId, ...cursor === void 0 ? {} : { afterSeq: cursor }, limit: 100 })
      );
    },
    async messages() {
      return zcodeMessages(
        /** @type {Parameters<typeof zcodeMessages>[0]} */
        await request("session/messages", { sessionId })
      );
    },
    async stop() {
      await request("session/stop", { sessionId });
    },
    async readIdle() {
      return (
        /** @type {IdleSnapshot} */
        await read()
      );
    },
    async closeSession() {
      const response = (
        /** @type {{closed?: boolean}} */
        await request("session/close", { sessionId, expectedPersistence: "immediate" })
      );
      return response?.closed === true;
    },
    close() {
      closed = true;
      unsubscribe();
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new ZCodeProtocolError("cancellation_pending", "ZCode transport closed"));
      }
      pending.clear();
    }
  };
}
function zcodeIdleObservation(snapshot, identity) {
  const runtime = snapshot?.runtime;
  const projection = snapshot?.projection;
  const observed = {
    sessionId: snapshot?.session?.sessionId,
    status: snapshot?.session?.status,
    activeTurnId: runtime?.activeTurnId,
    activeTurnKind: runtime?.activeTurnKind,
    pendingRequestIds: runtime?.pendingRequestIds,
    currentTurnId: projection?.currentTurnId,
    projectionStatus: projection?.status,
    pendingPermissions: Array.isArray(projection?.pendingPermissions) ? projection.pendingPermissions.map((permission) => ({ requestId: permission.requestId, toolCallId: permission.toolCallId })) : void 0,
    activeToolCalls: Array.isArray(projection?.activeToolCalls) ? projection.activeToolCalls.map((tool) => ({ toolCallId: tool.toolCallId, toolName: tool.toolName, status: tool.status })) : void 0
  };
  const idle = observed.sessionId === identity.sessionId && observed.status === "idle" && !!runtime && !observed.activeTurnId && !observed.activeTurnKind && Array.isArray(observed.pendingRequestIds) && observed.pendingRequestIds.length === 0 && !!projection && (!observed.currentTurnId || observed.currentTurnId === identity.turnId) && observed.pendingPermissions?.length === 0 && !!observed.activeToolCalls && observed.activeToolCalls.every((tool) => ["completed", "failed", "denied"].includes(tool.status));
  return { idle, observed };
}
function zcodeIsTerminal(event) {
  return terminalTypes.has(event.type);
}
function zcodeProofEvent(event) {
  if (zcodeIsTerminal(event) || event.type === "turn.started" || event.type === "tool.updated") return event;
  if (event.type !== "session.updated" || typeof event.payload?.toolCount !== "number") return void 0;
  const keys = ["messageCount", "providerId", "modelId", "temperature", "maxTokens", "toolCount", "iteration"];
  if (Object.keys(event.payload).some((key) => !keys.includes(key))) {
    throw new ZCodeProtocolError("stale_result", "ZCode ModelRequest includes unknown evidence fields");
  }
  return event;
}
function zcodeProviderUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const native = (
    /** @type {NativeRecord} */
    value
  );
  if (native.source !== "provider") return void 0;
  const usage = { source: "zcode-turn-usage" };
  for (
    const [field, nativeField] of
    /** @type {const} */
    [
      ["totalInputTokens", "inputTokens"],
      ["outputTokens", "outputTokens"],
      ["cacheReadInputTokens", "cacheReadTokens"],
      ["cacheWriteInputTokens", "cacheWriteTokens"]
    ]
  ) {
    const count = native[nativeField];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) usage[field] = count;
  }
  return Object.keys(usage).length > 1 ? usage : void 0;
}
function zcodeEventCollector({ sessionId, inputId, queryId, initialTurnId, worktree }) {
  const events = [];
  const counts = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  let terminal;
  let cursor;
  let turnId = initialTurnId;
  return {
    get terminal() {
      return terminal;
    },
    get cursor() {
      return cursor;
    },
    get turnId() {
      return turnId;
    },
    get events() {
      return events;
    },
    get counts() {
      return Object.fromEntries(counts);
    },
    /**
     * @param {{events?: NativeEvent[]}} page
     * @param {{sent: boolean, model?: NativeModel, onTurn?(id: string): void | Promise<void>, onTerminal?(event: NativeEvent): void | Promise<void>}} observation
     */
    async accept(page, { sent, model, onTurn, onTerminal }) {
      if (page?.events !== void 0 && !Array.isArray(page.events)) throw new ZCodeProtocolError("stale_result", "ZCode native event page is malformed");
      for (const event of page?.events ?? []) {
        if (event?.sessionId !== sessionId || !Number.isSafeInteger(event.seq) || typeof event.eventId !== "string" || typeof event.type !== "string") {
          throw new ZCodeProtocolError("stale_result", "ZCode native event identity differs");
        }
        if (seen.has(event.eventId)) continue;
        seen.add(event.eventId);
        cursor = Math.max(cursor ?? -1, event.seq);
        counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
        if (!zcodeProofEvent(event)) continue;
        if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
          throw new ZCodeProtocolError("stale_result", "ZCode native evidence payload is malformed");
        }
        if (event.type === "turn.started") {
          if (!sent || turnId || typeof event.turnId !== "string" || !event.turnId || event.payload?.inputId !== inputId || event.payload?.queryId !== queryId) {
            throw new ZCodeProtocolError("stale_result", "ZCode has no exact original input/query turn identity");
          }
          turnId = event.turnId;
          await onTurn?.(turnId);
        }
        if (!turnId || event.turnId !== turnId) throw new ZCodeProtocolError("stale_result", "ZCode evidence event belongs to another turn");
        if (event.type === "session.updated" && (!model || event.payload.providerId !== model.providerId || event.payload.modelId !== model.modelId || !worktree && event.payload.toolCount !== 1)) {
          throw new ZCodeProtocolError("unsupported", "ZCode actual ModelRequest identity or toolCount differs");
        }
        if (!worktree && event.type === "tool.updated" && event.payload?.kind === "scheduled" && event.payload.toolName !== zcodeCapability.tool) {
          throw new ZCodeProtocolError("unsupported", "ZCode scheduled an uncontrolled tool");
        }
        let evidence = event;
        if (worktree && event.type === "turn.completed") {
          const { usage, ...payload } = event.payload;
          evidence = { ...event, payload, nativeTokenUsage: zcodeProviderUsage(usage) };
        }
        events.push(evidence);
        if (zcodeIsTerminal(event)) {
          if (event.payload?.inputId !== inputId) throw new ZCodeProtocolError("stale_result", "ZCode terminal belongs to another original input");
          if (terminal) throw new ZCodeProtocolError("stale_result", "ZCode returned multiple terminal events");
          terminal = evidence;
          await onTerminal?.(evidence);
        }
      }
      return terminal;
    }
  };
}
function decodeZCodeJsonText(rawText) {
  const text2 = rawText.trim();
  const fenced = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(text2);
  return fenced ? fenced[1] : text2;
}
function decodeZCodeStructuredText(text2) {
  try {
    return JSON.parse(decodeZCodeJsonText(text2));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const location = / at position (\d+)(?: \(line (\d+) column (\d+)\))?$/.exec(error.message);
    const category = [
      ["Expected ',' or '}' after property value in JSON", "expected_property_delimiter"],
      ["Expected ',' or ']' after array element in JSON", "expected_array_delimiter"],
      ["Unexpected end of JSON input", "unexpected_end"]
    ].find(([prefix]) => error.message.startsWith(prefix))?.[1] ?? "invalid_json";
    const diagnostic = { category, ...location ? { position: Number(location[1]), ...location[2] ? { line: Number(location[2]), column: Number(location[3]) } : {} } : {} };
    throw new ZCodeProtocolError("structured_output_format_invalid", `ZCode terminal response is not one strict JSON document: ${JSON.stringify(diagnostic)}`);
  }
}
function zcodeSuccessfulTerminal(identity, terminal) {
  if (identity.turnId && terminal?.type === "turn.completed" && terminal.sessionId === identity.sessionId && terminal.turnId === identity.turnId && terminal.payload?.inputId === identity.inputId && terminal.payload.resultType === "success" && typeof terminal.payload.response === "string") {
    return terminal.payload.response;
  }
  return void 0;
}
function zcodeWorktreeTurnMatches(plan, snapshot, events, terminals, terminal) {
  const starts = events.filter((event) => event.type === "turn.started");
  const requests = events.filter((event) => event.type === "session.updated");
  return !!plan.turnId && typeof plan.model?.providerId === "string" && !!plan.model.providerId && typeof plan.model.modelId === "string" && !!plan.model.modelId && snapshot.sessionId === plan.sessionId && JSON.stringify(snapshot.model) === JSON.stringify(plan.model) && starts.length === 1 && starts[0].payload.inputId === plan.inputId && starts[0].payload.queryId === plan.queryId && typeof starts[0].payload.messageId === "string" && !!starts[0].payload.messageId && events.every((event) => event.sessionId === plan.sessionId && event.turnId === plan.turnId && Number.isSafeInteger(event.seq) && typeof event.eventId === "string") && new Set(events.map((event) => event.eventId)).size === events.length && requests.length > 0 && requests.every((event) => event.payload.providerId === plan.model?.providerId && event.payload.modelId === plan.model?.modelId) && terminals.length === 1 && JSON.stringify(terminals[0]) === JSON.stringify(terminal) && terminal.sessionId === plan.sessionId && terminal.turnId === plan.turnId && terminal.payload.inputId === plan.inputId;
}
function zcodeWorktreeResponse({ identity, model, prompt, terminal, events, messages }) {
  const starts = events.filter((event) => event.type === "turn.started");
  const requests = events.filter((event) => event.type === "session.updated");
  const response = zcodeSuccessfulTerminal(identity, terminal);
  if (response === void 0 || starts.length !== 1 || starts[0].payload.inputId !== identity.inputId || starts[0].payload.queryId !== identity.queryId || starts[0].turnId !== identity.turnId || !events.some((event) => JSON.stringify(event) === JSON.stringify(terminal)) || events.some((event) => event.sessionId !== identity.sessionId || event.turnId !== identity.turnId) || !requests.length || requests.some((event) => event.payload.providerId !== model.providerId || event.payload.modelId !== model.modelId)) {
    throw new ZCodeProtocolError("stale_result", "ZCode worktree exact native model/terminal/process evidence differs");
  }
  const text2 = (message) => message.parts?.filter((part) => part.type === "text").map((part) => part.text).join("");
  const users = messages.filter((message) => message.info?.role === "user" && /** @type {NativeRecord | undefined} */
  message.info.semantics?.kind === "user_prompt");
  const user = users[0];
  const userId = starts[0].payload.messageId;
  if (users.length !== 1 || !user.info || typeof userId !== "string" || !userId || text2(user) !== prompt) {
    throw new ZCodeProtocolError("stale_result", "ZCode worktree original native user/input differs");
  }
  const assistants = messages.filter((message) => message.info?.role === "assistant" && /** @type {NativeRecord | undefined} */
  message.info.semantics?.kind === "assistant_response");
  const usesCurrentMessageIdentity = ({ info, parts }) => !!info && ("messageId" in info || "sessionId" in info || "parentMessageId" in info) || parts?.some((part) => "messageId" in part || "sessionId" in part) === true;
  if (usesCurrentMessageIdentity(user) || assistants.some(usesCurrentMessageIdentity)) {
    const messageIds = /* @__PURE__ */ new Set();
    const bindMessage = ({ info, parts }) => {
      const id = info?.messageId;
      if (typeof id !== "string" || !id || info?.sessionId !== identity.sessionId || messageIds.has(id) || !parts?.length || !parts.every((part) => part.messageId === id && part.sessionId === identity.sessionId)) return false;
      messageIds.add(id);
      return true;
    };
    if (user.info.messageId !== userId || !isDeepStrictEqual(user.info.model, model) || !bindMessage(user)) {
      throw new ZCodeProtocolError("stale_result", "ZCode worktree original native user/input differs");
    }
    const final = assistants.at(-1);
    const finalModel = (
      /** @type {NativeModel | undefined} */
      final?.info?.model
    );
    if (!final || assistants.some((message) => message.info?.parentMessageId !== userId || !bindMessage(message)) || finalModel?.providerId !== model.providerId || finalModel?.modelId !== model.modelId || text2(final) !== response) {
      throw new ZCodeProtocolError("stale_result", "ZCode worktree final assistant identity/response differs");
    }
  } else {
    const turn = (message) => (
      /** @type {NativeRecord | undefined} */
      message.info?.anchor?.turnId
    );
    if (user.info.id !== userId || turn(user) !== identity.turnId || JSON.stringify(user.info.modelSelection) !== JSON.stringify(model) || user.info.sessionID !== identity.sessionId) {
      throw new ZCodeProtocolError("stale_result", "ZCode worktree original native user/input differs");
    }
    const final = assistants.filter((message) => turn(message) === identity.turnId).at(-1);
    if (!final || final.info?.providerId !== model.providerId || final.info?.modelId !== model.modelId || text2(final) !== response) {
      throw new ZCodeProtocolError("stale_result", "ZCode worktree final assistant identity/response differs");
    }
  }
  return { text: response, nativeTokenUsage: terminal.nativeTokenUsage };
}
function stale(message) {
  throw new ZCodeProtocolError("stale_result", `ZCode ${message}`);
}
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) stale("native evidence requires an object");
  return (
    /** @type {NativeRecord} */
    value
  );
}
function zcodeMcpClientMatches(client, cliVersion) {
  return client.name === "zcode" && client.version === cliVersion;
}
function assertZCodeMcpRequestContext(meta, { sessionId, turnId }) {
  if (meta.session_id !== sessionId || meta.turn_id !== turnId) stale("MCP call differs from its original reader/session/turn");
  const context = meta["com.zcode/request-context"];
  if (context !== void 0) {
    const nested = record(context);
    if (nested.session_id !== sessionId || nested.turn_id !== turnId) stale("MCP nested request context differs");
  }
}
function text(value) {
  if (typeof value !== "string" || !value) stale("native evidence requires a nonempty identity");
  return value;
}
function complete(value) {
  for (const key of ["truncated", "omitted", "inputOmitted", "outputOmitted"])
    if (value[key] !== void 0 && value[key] !== false) stale("native evidence is truncated or omitted");
}
function observeZCodeFrozenReadTurn({ sessionId, turnId, inputId, prompt, providerId, modelId, send: rawSend, messages: rawMessages, events: rawEvents, expectedTool }) {
  text(expectedTool);
  const send = record(rawSend);
  if (send.sessionId !== sessionId || send.content !== prompt || send.inputId !== inputId) stale("send differs from the exact frozen prompt/input");
  if (!Array.isArray(rawMessages) || !Array.isArray(rawEvents)) stale("witness lacks raw native messages/events");
  const messages = /* @__PURE__ */ new Map();
  const calls = /* @__PURE__ */ new Map();
  const partIds = /* @__PURE__ */ new Set(), rawMessageIds = /* @__PURE__ */ new Set();
  let user;
  const runtimeSources = /* @__PURE__ */ new Set();
  const requestPrefixCounts = [];
  let assistantCount = 0;
  let modelChangeTime;
  for (const message of rawMessages) {
    record(message);
    const info = record(message.info), id = text(info.id);
    if (rawMessageIds.has(id) || info.sessionID !== sessionId || !["user", "assistant"].includes(String(info.role)) || !Array.isArray(message.parts)) stale("raw message identity or role differs");
    rawMessageIds.add(id);
    for (const raw of message.parts) {
      const part = record(raw), partId = text(part.id);
      if (partIds.has(partId) || part.sessionID !== sessionId || part.messageID !== id) stale("raw part is not bound to its exact message/session");
      partIds.add(partId);
      complete(part);
    }
    const semantics = record(info.semantics);
    if (semantics.providerVisibility === "hidden") {
      const part = record(message.parts[0]), time = record(info.time), tokens = record(info.tokens), cache = record(tokens.cache), location = record(info.path);
      if (rawMessageIds.size !== 1 || info.role !== "assistant" || info.anchor !== void 0 || info.parentID !== id || info.modelId !== modelId || info.providerId !== providerId || typeof info.mode !== "string" || typeof info.planEnabled !== "boolean" || typeof info.agent !== "string" || typeof location.cwd !== "string" || typeof location.root !== "string" || Object.keys(location).some((key) => !["cwd", "root"].includes(key)) || info.cost !== 0 || info.finish !== "completed" || !Number.isSafeInteger(time.created) || Number(time.created) < 0 || !isDeepStrictEqual(time, { created: time.created, completed: time.created }) || !isDeepStrictEqual(semantics, { origin: "system", kind: "timeline_event", uiVisibility: "visible", providerVisibility: "hidden", transcriptVisibility: "visible" }) || Object.keys(info).some((key) => !["id", "sessionID", "role", "time", "parentID", "modelId", "providerId", "mode", "planEnabled", "agent", "path", "cost", "tokens", "finish", "semantics"].includes(key)) || tokens.input !== 0 || tokens.output !== 0 || tokens.reasoning !== 0 || tokens.total !== void 0 && tokens.total !== 0 || !isDeepStrictEqual(cache, { read: 0, write: 0 }) || Object.keys(tokens).some((key) => !["input", "output", "reasoning", "cache", "total"].includes(key)) || message.parts.length !== 1 || part.type !== "timeline" || part.timelineType !== "model_change" || part.display !== "separator" || part.status !== "completed" || !isDeepStrictEqual(part.time, { start: time.created, end: time.created }) || Object.keys(part).some((key) => !["id", "sessionID", "messageID", "type", "timelineType", "display", "status", "time", "fromModel", "toModel"].includes(key))) stale("hidden message is not a pre-turn display-only native model change");
      for (const value of [part.fromModel, part.toModel].filter((value2) => value2 !== void 0)) {
        const model = record(value);
        if (!text(model.providerId).trim() || !text(model.modelId).trim() || model.label !== void 0 && typeof model.label !== "string" || Object.keys(model).some((key) => !["providerId", "modelId", "options", "label"].includes(key))) stale("model change contains an unknown model selection payload");
        if (model.options !== void 0) {
          const options = record(model.options);
          if (Object.keys(options).some((key) => key !== "reasoningLevel") || options.reasoningLevel !== void 0 && (typeof options.reasoningLevel !== "string" || !options.reasoningLevel.trim())) stale("model change contains invalid model options");
        }
      }
      const target = record(part.toModel);
      if (target.providerId !== providerId || target.modelId !== modelId) stale("model change target differs from the fixed model");
      modelChangeTime = Number(time.created);
      continue;
    }
    messages.set(id, info);
    const anchor = record(info.anchor);
    if (anchor.turnId !== turnId || semantics.providerVisibility !== "visible") stale("message is outside the exact model-visible native turn");
    if (info.role === "user") {
      const model = record(info.modelSelection);
      if (model.providerId !== providerId || model.modelId !== modelId) stale("user input has a foreign native model selection");
      if (info.synthetic === true) {
        const source = text(semantics.source), metadata = record(info.metadata);
        const silentReminder = source === "silent_turn_reminder";
        if (!["environment", "model", "runtime_mode", "date", "silent_turn_reminder"].includes(source) || !silentReminder && (runtimeSources.has(source) || assistantCount > 0) || anchor.origin !== "synthetic" || info.visibility !== "model-only" || semantics.origin !== "agent_runtime" || semantics.kind !== "system_reminder" || semantics.uiVisibility !== "hidden" || semantics.transcriptVisibility !== "hidden" || metadata.source !== source || metadata.visibility !== "model-only" || record(metadata.runtimeMessage).source !== source || message.parts.length !== 1) stale("synthetic user is not a known same-turn native runtime reminder");
        if (silentReminder && (assistantCount === 0 || message.parts[0].text !== "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell \u2014 a finding, a change of plan.")) stale("silent reminder differs from its known native body or mid-turn position");
        runtimeSources.add(source);
      } else {
        if (user || anchor.origin !== "realUser" || semantics.origin !== "real_user" || semantics.kind !== "user_prompt" || semantics.uiVisibility !== "visible" || semantics.transcriptVisibility !== "visible") stale("history contains another or unrecognized real user input");
        if (modelChangeTime !== void 0 && (!Number.isSafeInteger(record(info.time).created) || Number(record(info.time).created) < modelChangeTime)) stale("display-only model change was inserted after the real user input");
        text(anchor.sourceCommandId);
        user = message;
      }
    } else {
      requestPrefixCounts.push(messages.size - 1);
      assistantCount++;
      if (info.providerId !== providerId || info.modelId !== modelId || info.error !== void 0 || semantics.origin !== "agent_runtime" || semantics.kind !== "assistant_response" || semantics.uiVisibility !== "visible" || semantics.transcriptVisibility !== "visible") stale("assistant has a foreign model, origin or native error");
    }
    for (const raw of message.parts) {
      const part = record(raw);
      if (part.type !== "tool") {
        if (["text", "reasoning"].includes(String(part.type)) && typeof part.text !== "string") stale("native text part lacks its original text");
        if (!["text", "reasoning", "step-start", "step-finish"].includes(String(part.type)) || info.role === "user" && (part.type !== "text" || part.synthetic === true !== (info.synthetic === true) || info.synthetic === true && !isDeepStrictEqual(part.metadata, info.metadata))) stale("native message contains unsupported input or part");
        continue;
      }
      const callId = text(part.callID), state = record(part.state);
      complete(state);
      const metadata = record(state.metadata), serialization = record(metadata.serialization);
      complete(metadata);
      complete(serialization);
      const bytes = typeof state.output === "string" ? Buffer.byteLength(state.output, "utf8") : -1;
      if (serialization.truncated !== false || serialization.originalBytes !== bytes || serialization.returnedBytes !== bytes) stale("raw tool part serialization is incomplete or truncated");
      if (info.role !== "assistant" || calls.has(callId) || part.tool !== expectedTool || state.status !== "completed" || typeof state.output !== "string") stale("tool part is foreign, repeated, pending or incomplete");
      record(state.input);
      calls.set(callId, { messageId: id, state });
    }
  }
  if (!user || user.parts.map((part) => part.text).join("") !== prompt) stale("original native user message differs from the exact prompt");
  if (send.modelSelection !== void 0 && !isDeepStrictEqual(send.modelSelection, user.info.modelSelection)) stale("explicit native send model selection differs from the original real user");
  const userId = text(user.info.id);
  for (const [id, info] of messages) {
    if (info.role !== "assistant") continue;
    const seen = /* @__PURE__ */ new Set([id]);
    let parent = text(info.parentID);
    while (parent !== userId) {
      if (seen.has(parent) || !messages.has(parent)) stale("assistant parent chain is outside the original user input");
      seen.add(parent);
      parent = text(
        /** @type {NativeRecord} */
        messages.get(parent).parentID
      );
    }
  }
  const finalMessage = rawMessages.at(-1), finalAnchor = record(finalMessage.info.anchor);
  if (finalMessage.info.role !== "assistant" || finalAnchor.boundaryMessageId !== finalMessage.info.id || !isDeepStrictEqual(finalAnchor.orderedMessageIds, [...messages.keys()]) || finalAnchor.historyRoundCount !== assistantCount) stale("final native boundary does not close its exact ordered message history");
  const assistants = [...messages].filter(([, info]) => info.role === "assistant"), assistantIndices = new Map(assistants.map(([id], index) => [id, index]));
  const eventIds = /* @__PURE__ */ new Set(), started = /* @__PURE__ */ new Set();
  const scheduled = /* @__PURE__ */ new Map(), results = /* @__PURE__ */ new Map();
  const requests = [];
  let previousSeq = -1, began = false, ended = false;
  let response;
  for (const raw of rawEvents) {
    const event = record(raw), payload = record(event.payload);
    if (event.sessionId !== sessionId || event.turnId !== turnId || !Number.isSafeInteger(event.seq) || Number(event.seq) <= previousSeq || eventIds.has(text(event.eventId)) || ended) stale("event identity, order or terminal boundary differs");
    const seq = Number(event.seq);
    previousSeq = seq;
    eventIds.add(String(event.eventId));
    if (event.type === "turn.started") {
      if (began || payload.input !== prompt || payload.inputId !== inputId || payload.messageId !== userId || payload.turnNumber !== 0 || payload.attachments !== void 0 && (!Array.isArray(payload.attachments) || payload.attachments.length > 0)) stale("turn start differs from the unique original user/input");
      began = true;
      continue;
    }
    if (!began) stale("evidence precedes its original native turn start");
    if (event.type === "turn.completed") {
      if (payload.resultType !== "success" || payload.inputId !== inputId || typeof payload.response !== "string" || payload.error !== void 0 || payload.toolCallCount !== calls.size) stale("turn has no exact successful native completion");
      response = payload.response;
      ended = true;
      continue;
    }
    if (event.type === "session.updated") {
      if (payload.providerId !== providerId || payload.modelId !== modelId || payload.toolCount !== 1 || payload.iteration !== Math.ceil(results.size / 10) || payload.messageCount !== requestPrefixCounts[requests.length] + results.size) stale("actual ModelRequest has a foreign model, tool surface or iteration");
      requests.push(seq);
      continue;
    }
    if (event.type !== "tool.updated") stale("evidence contains a foreign turn, user input or unsupported event");
    if (payload.toolName !== void 0 && payload.toolName !== expectedTool || ["source", "agentId", "childSessionId", "parentToolCallId"].some((key) => payload[key] !== void 0)) stale("tool event exposes a foreign tool or subagent");
    if (payload.kind === "batch") {
      if (!Array.isArray(payload.toolCallIds) || new Set(payload.toolCallIds).size !== payload.toolCallIds.length || payload.toolCallIds.some((id) => typeof id !== "string" || !results.has(id)) || payload.errorCount !== 0 || payload.successCount !== payload.toolCallIds.length) stale("tool batch differs from completed native calls");
      continue;
    }
    const callId = text(payload.toolCallId), call = calls.get(callId);
    if (!call) stale("tool event is outside the exact native reader call");
    if (payload.kind === "scheduled") {
      if (scheduled.has(callId) || payload.toolName !== expectedTool || payload.assistantMessageId !== call.messageId || !requests.length || payload.input !== void 0 && !isDeepStrictEqual(payload.input, call.state.input)) stale("scheduled tool differs from its original message/input");
      scheduled.set(callId, seq);
    } else if (payload.kind === "started") {
      if (!scheduled.has(callId) || started.has(callId)) stale("tool start has no unique original schedule");
      started.add(callId);
    } else if (payload.kind === "result") {
      const result = record(payload.result), bytes = Buffer.byteLength(String(call.state.output), "utf8");
      complete(result);
      if (!started.has(callId) || results.has(callId) || result.success !== true || result.truncated !== false || result.content !== call.state.output || result.originalBytes !== bytes || result.returnedBytes !== bytes) stale("native tool result is incomplete, substituted or truncated");
      results.set(callId, seq);
    } else if (payload.kind !== "progress" || !started.has(callId) || results.has(callId)) stale("tool event is not a supported successful lifecycle");
  }
  if (!ended || !requests.length || requests.length !== assistantCount || response === void 0 || scheduled.size !== calls.size || results.size !== calls.size) stale("turn or native call evidence is unfinished");
  if (finalMessage.parts.filter((part) => part.type === "text").map((part) => part.text).join("") !== response) stale("terminal response differs from its final native boundary message");
  const reads = [];
  for (const [callId, scheduleSeq] of scheduled) {
    const call = (
      /** @type {NonNullable<ReturnType<typeof calls.get>>} */
      calls.get(callId)
    );
    const index = (
      /** @type {number} */
      assistantIndices.get(call.messageId)
    ), consumer = requests[index + 1];
    const resultSeq = (
      /** @type {number} */
      results.get(callId)
    );
    if (scheduleSeq <= requests[index] || consumer === void 0 || resultSeq >= consumer) stale("reader lifecycle differs from its assistant generation and next ModelRequest consumer");
    reads.push({ callId, input: (
      /** @type {NativeRecord} */
      call.state.input
    ), output: (
      /** @type {string} */
      call.state.output
    ) });
  }
  return { calls, reads, response, realUserModelSelection: record(user.info.modelSelection) };
}
var zcodeCapability, ZCodeProtocolError, providerRejection, ZCodeNativeTurnFailedError, nativeRpcTimeoutMessage, zcodeVersionArgs, zcodeNativeIdentity, zcodeAppServerArgs, terminalTypes;
var init_zcode = __esm({
  "src/llm_manager/native/zcode.mjs"() {
    init_cli_probe();
    zcodeCapability = Object.freeze({
      cliVersion: "0.17.1",
      cliSha256: "9afd565a104d660259e6bdeeaa5cb8abc74a908559e21aa3c5f6a06f2a9da6c6",
      builtinSha256: "e537b380df05656e3757c2b220ae1044fe8a32c0ac148de265a05a94cc24b3a9",
      builtinPath: "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json",
      tool: "mcp__frozen__spex_read_frozen"
    });
    ZCodeProtocolError = class extends Error {
      /** @param {ProtocolErrorCode} code @param {string} message @param {{threadId?: string, turnId?: string}} [detail] */
      constructor(code, message, detail = {}) {
        super(message);
        this.name = "ZCodeProtocolError";
        this.code = code;
        this.detail = detail;
        this.threadId = detail.threadId;
        this.turnId = detail.turnId;
      }
    };
    providerRejection = "ZCode provider rejected the native turn (retryable=false)";
    ZCodeNativeTurnFailedError = class extends ZCodeProtocolError {
      /** @param {string} threadId @param {string} turnId @param {unknown} nativeCode @param {boolean} worktree @param {unknown} [nativeAttribution] @param {boolean} [quota] */
      constructor(threadId, turnId, nativeCode, worktree, nativeAttribution, quota = false) {
        const code = typeof nativeCode === "string" && Object.hasOwn(constants2.errno, nativeCode) ? nativeCode : "unavailable";
        const rejected = worktree && isZCodeProviderPipeFailure(code, nativeAttribution);
        super(
          quota ? "provider_quota_exhausted" : rejected ? "unsupported" : worktree && code === "EPIPE" ? "native_turn_transport_failed" : "failed",
          quota ? "ZCode provider returned HTTP 429" : rejected ? providerRejection : `ZCode native turn failed (code=${code})`,
          { threadId, turnId }
        );
      }
    };
    nativeRpcTimeoutMessage = (method) => `ZCode native RPC timeout (${method})`;
    zcodeVersionArgs = () => ["--version"];
    zcodeNativeIdentity = () => ({ sessionId: `sess_${randomUUID2()}`, inputId: randomUUID2(), queryId: randomUUID2() });
    zcodeAppServerArgs = (workspace) => ["app-server", "--cwd", workspace];
    terminalTypes = /* @__PURE__ */ new Set(["turn.completed", "turn.failed", "turn.cancelled"]);
  }
});

// src/llm_manager/native/index.mjs
init_claude();
init_codex();
init_cursor();
init_grok();
init_zcode();
import { spawn, spawnSync as spawnSync2 } from "node:child_process";
import { realpathSync as realpathSync2 } from "node:fs";
var nativeRuntimeVersion = 1;
var nativeAdapterContract = 3;
var commands = Object.freeze({
  claude: "claude",
  codex: "codex",
  cursor: "cursor-agent",
  grok: "grok",
  zcode: "zcode"
});
function loadNativeAdapter(vendor) {
  switch (vendor) {
    case "claude":
      return Promise.resolve().then(() => (init_claude(), claude_exports));
    case "codex":
      return Promise.resolve().then(() => (init_codex(), codex_exports));
    case "cursor":
      return Promise.resolve().then(() => (init_cursor(), cursor_exports));
    case "grok":
      return Promise.resolve().then(() => (init_grok(), grok_exports));
    case "zcode":
      return Promise.resolve().then(() => (init_zcode(), zcode_exports));
  }
}
function findNativeExecutable(vendor) {
  const located = spawnSync2("/usr/bin/which", [commands[vendor]], { encoding: "utf8", timeout: 1e4 });
  const executable = located.status === 0 && located.stdout.trim();
  return executable ? realpathSync2(executable) : void 0;
}
function spawnGatedNativeProcess(command, args, { cwd, env, stderr = "pipe" }) {
  return spawn("/bin/sh", [
    "-c",
    'IFS= read -r ready <&3 && [ "$ready" = start ] || exit 1; exec 3<&-; exec "$@"',
    "llm-manager-native",
    command,
    ...args
  ], { cwd, env, detached: true, stdio: ["pipe", "pipe", stderr, "pipe"] });
}
function spawnNativeProcess(command, args, { cwd, env }) {
  return spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
}
export {
  claude_exports as claudeReplay,
  codex_exports as codexReplay,
  cursor_exports as cursorReplay,
  findNativeExecutable,
  grok_exports as grokReplay,
  loadNativeAdapter,
  nativeAdapterContract,
  nativeRuntimeVersion,
  spawnGatedNativeProcess,
  spawnNativeProcess,
  zcode_exports as zcodeReplay
};
