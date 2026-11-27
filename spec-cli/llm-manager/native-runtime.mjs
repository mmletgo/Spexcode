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

// src/llm_manager/native/claude.mjs
var claude_exports = {};
__export(claude_exports, {
  CLAUDE_LEGACY_CLI_VERSION: () => CLAUDE_LEGACY_CLI_VERSION,
  CLAUDE_VERSION_ARGS: () => CLAUDE_VERSION_ARGS,
  ClaudeNativeProtocolError: () => ClaudeNativeProtocolError,
  assertClaudeLegacyConfiguration: () => assertClaudeLegacyConfiguration,
  claudeAuthenticationArgs: () => claudeAuthenticationArgs,
  claudeNativeModel: () => claudeNativeModel,
  claudeProcessEnvironment: () => claudeProcessEnvironment,
  claudeProtocolObservation: () => claudeProtocolObservation,
  claudeStructuredArgs: () => claudeStructuredArgs,
  claudeWorktreeArgs: () => claudeWorktreeArgs,
  encodeClaudeInterrupt: () => encodeClaudeInterrupt,
  encodeClaudeUserMessage: () => encodeClaudeUserMessage,
  interpretClaudeAuthenticationStatus: () => interpretClaudeAuthenticationStatus,
  interpretClaudeStreamEvent: () => interpretClaudeStreamEvent,
  isClaudeRateLimitTerminal: () => isClaudeRateLimitTerminal,
  prepareClaudeAuthenticationEnvironment: () => prepareClaudeAuthenticationEnvironment,
  readClaudeStreamEvent: () => readClaudeStreamEvent
});
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
var CLAUDE_LEGACY_CLI_VERSION, CLAUDE_VERSION_ARGS, authenticationKeys, isolatedSettings, streamArgs, ClaudeNativeProtocolError;
var init_claude = __esm({
  "src/llm_manager/native/claude.mjs"() {
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
      /** @param {'unsupported' | 'stale_result'} code @param {string} message */
      constructor(code, message) {
        super(message);
        this.name = "ClaudeNativeProtocolError";
        this.code = code;
      }
    };
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
function codexFrozenPrompt({ prompt, taskIsFrozen, contextDigest, maxReadBytes, maxResponseBytes, entries, plans }) {
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
  const instructions = taskIsFrozen ? `The complete original task, instructions, and context are frozen without truncation in entry task. Read its entire required content using ${frozenToolName}, then follow that original task and return its requested structured final answer. Byte offsets are end-exclusive; continue from the response's original endByte, never decodedEndByte. No shell, paths or live data are available.` : prompt;
  return { prompt: `${instructions}
${index}`, toolOutputTokenLimit };
}
function codexFrozenToolResponse(text) {
  return { contentItems: [{ type: (
    /** @type {const} */
    "inputText"
  ), text }], success: (
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
  const calls = /* @__PURE__ */ new Map();
  const returned = /* @__PURE__ */ new Set();
  const outputs = [];
  const turns = /* @__PURE__ */ new Set();
  const prompts = [];
  const finals = /* @__PURE__ */ new Set();
  let current;
  let completed = false;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const record = decodeRolloutLine(line);
    const payload = object(record.payload);
    if (record.type === "turn_context" || record.type === "event_msg" && payload.type === "task_started") {
      current = payload.turn_id;
      if (typeof current === "string") turns.add(current);
    }
    if (record.type === "event_msg" && payload.type === "task_complete" && payload.turn_id === turnId) {
      if (current !== turnId || completed)
        throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout completion does not belong to one exact turn");
      if (typeof payload.last_agent_message === "string") finals.add(payload.last_agent_message);
      completed = true;
      current = void 0;
    }
    if (current !== turnId) continue;
    if (record.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") prompts.push(payload.message);
    if (record.type === "event_msg" && payload.type === "agent_message" && payload.phase === "final_answer" && typeof payload.message === "string" && payload.message) finals.add(payload.message);
    if (record.type !== "response_item") continue;
    if (payload.type === "custom_tool_call" || payload.type === "function_call") {
      const name2 = payload.type === "custom_tool_call" ? "exec" : "wait";
      if (payload.name !== name2 || typeof payload.call_id !== "string" || !payload.call_id || calls.has(payload.call_id))
        throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout contains an invalid or repeated host call");
      calls.set(payload.call_id, name2);
      continue;
    }
    if (payload.type !== "custom_tool_call_output" && payload.type !== "function_call_output") continue;
    const name = payload.type === "custom_tool_call_output" ? "exec" : "wait";
    const { call_id: callId, output } = payload;
    const limit = object(record.metadata).fallback_token_limit_override;
    if (typeof callId !== "string" || calls.get(callId) !== name || returned.has(callId) || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0 || !(typeof output === "string" || Array.isArray(output) && output.every((block) => object(block).type === "input_text" && typeof object(block).text === "string")))
      throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout output does not match its exact host call and history budget");
    returned.add(callId);
    outputs.push({ callId, output, historyTokenLimit: limit });
  }
  if (turns.size && !turns.has(turnId))
    throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout contains a different turn");
  if (requireCompleted && !completed)
    throw new CodexNativeProtocolError("not_materialized", "Codex frozen rollout has not persisted its exact completed turn");
  if (completed && returned.size !== calls.size)
    throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout contains a completed host call without its output");
  return { outputs, turns, prompts, finals };
}
function codexReadFrozenRollout(options) {
  const source = readRolloutFile(options.path);
  const history = decodeRollout(source.bytes, options, options.requireCompleted ?? true);
  if (!history.turns.has(options.turnId))
    throw new CodexNativeProtocolError("stale_result", "Codex frozen rollout does not identify the exact turn");
  return { path: source.path, archived: basename(dirname(source.path)) === "archived_sessions", outputs: history.outputs };
}
function codexValidateFrozenVisibility(outputs, toolOutputTokenLimit, expectedResponses) {
  const budget = codexExecMaxOutputTokens(toolOutputTokenLimit);
  const callIds = /* @__PURE__ */ new Set();
  const texts = /* @__PURE__ */ new Set();
  for (const { callId, output, historyTokenLimit } of outputs) {
    const bodies = typeof output === "string" ? [output] : output.map((block) => block.text);
    const cost = bodies.reduce((total, body) => total + codexTextTokenCost(Buffer.byteLength(body, "utf8")), 0);
    if (!callId || callIds.has(callId) || historyTokenLimit !== budget || cost > budget)
      throw new CodexNativeProtocolError("stale_result", "Codex frozen model-visible body differs from its fixed history budget");
    callIds.add(callId);
    for (const body of bodies) texts.add(body);
  }
  if (expectedResponses.some((response) => !texts.has(response)))
    throw new CodexNativeProtocolError("stale_result", "Codex frozen body was not returned verbatim in the exact model-visible history");
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
  cursorUsageLimitNotice: () => cursorUsageLimitNotice,
  encodeCursorAcpPacket: () => encodeCursorAcpPacket,
  observeCursorAcp: () => observeCursorAcp
});
import { randomUUID } from "node:crypto";
import { isAbsolute as isAbsolute2, relative, resolve } from "node:path";
import { createInterface as createInterface2 } from "node:readline";
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
  grokAcpArguments: () => grokAcpArguments,
  grokAcpProbeArguments: () => grokAcpProbeArguments,
  grokInvocationEnvironment: () => grokInvocationEnvironment,
  grokInvocationFlags: () => grokInvocationFlags,
  grokStderrHasQuotaExhaustion: () => grokStderrHasQuotaExhaustion,
  grokStreamingArguments: () => grokStreamingArguments,
  grokSupportsAcp: () => grokSupportsAcp,
  grokSupportsStreamingSchema: () => grokSupportsStreamingSchema,
  observeGrokNativeAcp: () => observeGrokNativeAcp,
  observeGrokNativeStderr: () => observeGrokNativeStderr,
  observeGrokNativeStreaming: () => observeGrokNativeStreaming
});
import { createHash as createHash4 } from "node:crypto";
import { createInterface as createInterface3 } from "node:readline";
import { finished } from "node:stream/promises";
function grokAcpProbeArguments() {
  return ["--no-auto-update", "agent", "--help"];
}
function grokSupportsAcp(help) {
  return /^[\t ]+stdio[\t ]/m.test(help) && /^[\t ]+--no-leader(?:[\t ]|\r?$)/m.test(help);
}
function grokSupportsStreamingSchema(help) {
  return /^[\t ]*--json-schema(?:[\t ]|\r?$)/m.test(help);
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
  if (meta.usage !== void 0 && !usage || usage?.modelUsage !== void 0 && !modelUsage || stopReason === "end_turn" && !modelEntries.length || modelEntries.some(([model, value]) => !/^[a-z\d][a-z\d._:/-]*$/i.test(model) || !object4(value)))
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
      if (event.sessionId !== sessionId || event.cwd !== cwd || typeof requestId !== "string" || !requestId.trim() || typeof stopReason !== "string" || !stopReason || models2.some((model) => !model.trim()) || stopReason === "end_turn" && !models2.length)
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
function nativeHttpStatus(text) {
  const prefix = /^(?:error:[ \t]*)?HTTP(?:\/[1-3](?:\.[01])?)?[ \t]+/i.exec(text);
  if (!prefix) return null;
  let value = text.slice(prefix[0].length);
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
      const startupLine = line.toString("utf8", 0, lineBytes).replace(/\r$/, ""), text = startupLine.trim();
      const argument = /^error: unexpected argument '(--[a-z][a-z-]*)' found$/.exec(startupLine);
      if (argument && argument[0] === startupLine && flags.has(argument[1])) startupErrors.set(argument[1], { kind: "unexpected_argument", flag: argument[1] });
      const errno = startupLine === "Error: No such file or directory (os error 2)" ? "ENOENT" : startupLine === "Error: Permission denied (os error 13)" ? "EACCES" : void 0;
      if (errno) startupErrors.set(errno, { kind: "os_error", errno });
      const status = nativeHttpStatus(text);
      if (status) httpStatuses.add(status.code);
      const body = (status?.message ?? text.replace(/^error:[ \t]*/i, "")).trimStart();
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
  assertZCodeModelSnapshot: () => assertZCodeModelSnapshot,
  decodeZCodeJsonText: () => decodeZCodeJsonText,
  decodeZCodeStructuredText: () => decodeZCodeStructuredText,
  isZCodeEventsRpcTimeout: () => isZCodeEventsRpcTimeout,
  isZCodeEventsTimeout: () => isZCodeEventsTimeout,
  isZCodeProviderPipeFailure: () => isZCodeProviderPipeFailure,
  isZCodeProviderRejection: () => isZCodeProviderRejection,
  isZCodePublicHttp429: () => isZCodePublicHttp429,
  nativeRpcTimeoutMessage: () => nativeRpcTimeoutMessage,
  zcodeAppServerArgs: () => zcodeAppServerArgs,
  zcodeAssertSendAck: () => zcodeAssertSendAck,
  zcodeCapability: () => zcodeCapability,
  zcodeCreateInput: () => zcodeCreateInput,
  zcodeEventCollector: () => zcodeEventCollector,
  zcodeIdleObservation: () => zcodeIdleObservation,
  zcodeIsTerminal: () => zcodeIsTerminal,
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
  const text = rawText.trim();
  const fenced = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(text);
  return fenced ? fenced[1] : text;
}
function decodeZCodeStructuredText(text) {
  try {
    return JSON.parse(decodeZCodeJsonText(text));
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
  const text = (message) => message.parts?.filter((part) => part.type === "text").map((part) => part.text).join("");
  const users = messages.filter((message) => message.info?.role === "user" && /** @type {NativeRecord | undefined} */
  message.info.semantics?.kind === "user_prompt");
  const user = users[0];
  const userId = starts[0].payload.messageId;
  if (users.length !== 1 || !user.info || typeof userId !== "string" || !userId || text(user) !== prompt) {
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
    if (!final || assistants.some((message) => message.info?.parentMessageId !== userId || !bindMessage(message)) || finalModel?.providerId !== model.providerId || finalModel?.modelId !== model.modelId || text(final) !== response) {
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
    if (!final || final.info?.providerId !== model.providerId || final.info?.modelId !== model.modelId || text(final) !== response) {
      throw new ZCodeProtocolError("stale_result", "ZCode worktree final assistant identity/response differs");
    }
  }
  return { text: response, nativeTokenUsage: terminal.nativeTokenUsage };
}
var zcodeCapability, ZCodeProtocolError, providerRejection, ZCodeNativeTurnFailedError, nativeRpcTimeoutMessage, zcodeVersionArgs, zcodeNativeIdentity, zcodeAppServerArgs, terminalTypes;
var init_zcode = __esm({
  "src/llm_manager/native/zcode.mjs"() {
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
import { spawn, spawnSync } from "node:child_process";
import { realpathSync as realpathSync2 } from "node:fs";
var nativeRuntimeVersion = 1;
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
  const located = spawnSync("/usr/bin/which", [commands[vendor]], { encoding: "utf8", timeout: 1e4 });
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
  findNativeExecutable,
  loadNativeAdapter,
  nativeRuntimeVersion,
  spawnGatedNativeProcess,
  spawnNativeProcess
};
