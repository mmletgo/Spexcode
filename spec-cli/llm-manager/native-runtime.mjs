// Generated from LLM Manager 69a75baa0d641cbb929b55de9d0aa60010ab2e24 by npm run build:native-runtime.
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
  const models = Object.values(value);
  if (!models.length || !models.every(isObject)) return;
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
    const counts = models.map((model) => model[nativeField]);
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

// src/llm_manager/native/codex.mjs
var codex_exports = {};
__export(codex_exports, {
  CodexNativeAppServer: () => CodexNativeAppServer,
  CodexNativeProtocolError: () => CodexNativeProtocolError,
  codexNativeModel: () => codexNativeModel,
  codexNativeTokenUsage: () => codexNativeTokenUsage,
  codexNativeWorktreeArgs: () => codexNativeWorktreeArgs
});
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
function object(value) {
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
  const info = object(turn?.error).codexErrorInfo;
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded")
    return new CodexNativeProtocolError("provider_quota_exhausted", `Codex exact native turn failed (${info})`);
  if (nonempty(info) && nativeErrorKinds.has(info)) return failed(`Codex exact native turn failed (${info})`);
  for (const kind of nativeHttpErrorKinds) {
    const status = object(object(info)[kind]).httpStatusCode;
    if (status === 429)
      return new CodexNativeProtocolError("provider_quota_exhausted", `Codex exact native turn failed (${kind}, HTTP 429)`);
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
      return failed(`Codex exact native turn failed (${kind}, HTTP ${status})`);
  }
  return failed("Codex exact native turn did not complete successfully");
}
var CONTROL_MS, nativeErrorKinds, nativeHttpErrorKinds, CodexNativeProtocolError, CodexNativeAppServer;
var init_codex = __esm({
  "src/llm_manager/native/codex.mjs"() {
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
    CodexNativeProtocolError = class extends Error {
      /** @param {ErrorCode} code @param {string} message @param {unknown} [cause] */
      constructor(code, message, cause) {
        super(message, { cause });
        this.name = "CodexNativeProtocolError";
        this.code = code;
      }
    };
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
            this.#receive(object(JSON.parse(line)));
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
            this.#observe(packet.method, object(packet.params));
          }
        } else if (typeof packet.id === "number") {
          const waiter = this.#pending.get(packet.id);
          this.#pending.delete(packet.id);
          if (waiter && packet.error) waiter.reject(failed(`Codex app-server rejected ${waiter.method}`));
          else waiter?.resolve(object(packet.result));
        }
      }
      /** @param {string} method @param {Packet} params */
      #observe(method, params) {
        if (!this.#threadId || params.threadId !== this.#threadId) return;
        if (method === "turn/completed") {
          const turn = object(params.turn);
          if (!nonempty(turn.id)) return;
          if (this.#completions.has(turn.id)) throw failed("Codex repeated its exact terminal event");
          this.#completions.set(turn.id, turn);
          if (turn.id === this.#turnId) this.#wake();
        } else if (nonempty(params.turnId)) {
          if (method === "item/completed") {
            const item = object(params.item);
            if (item.type === "agentMessage" && item.phase === "final_answer")
              this.#finals.set(params.turnId, [...this.#finals.get(params.turnId) ?? [], item]);
          } else if (method === "thread/tokenUsage/updated") {
            this.#usages.set(params.turnId, object(object(params.tokenUsage).total));
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
        const effective = object((await this.#request("config/read", { cwd: workspace, includeLayers: false })).config);
        const config = {
          ...permissions?.shellPath ? { "shell_environment_policy.set.PATH": permissions.shellPath, allow_login_shell: false } : {},
          ...permissions ? {
            [`permissions.${permissions.name}.filesystem`]: Object.fromEntries([
              [":root", "read"],
              ...permissions.writableRoots.map((path) => [path, "write"])
            ]),
            [`permissions.${permissions.name}.network.enabled`]: false
          } : {},
          mcp_servers: Object.fromEntries(Object.keys(object(effective.mcp_servers)).map((server) => [server, { enabled: false }]))
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
        const row = object(thread.thread);
        const sandbox = object(thread.sandbox);
        const profile = object(thread.activePermissionProfile);
        if (!nonempty(row.id) || row.cwd !== workspace || row.ephemeral !== true || row.path !== null || !nonempty(row.cliVersion) || thread.cwd !== workspace || thread.approvalPolicy !== "never" || sandbox.networkAccess !== false || !Array.isArray(thread.runtimeWorkspaceRoots) || thread.runtimeWorkspaceRoots.length !== 1 || thread.runtimeWorkspaceRoots[0] !== workspace || !nonempty(thread.model) || model !== void 0 && thread.model !== model || (permissions ? profile.id !== permissions.name || sandbox.type !== "workspaceWrite" || !Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.some((path) => !permissions.writableRoots.includes(path)) : sandbox.type !== "readOnly"))
          throw new CodexNativeProtocolError("unsupported", "Codex did not confirm the exact model, worktree and permission boundary");
        this.#threadId = row.id;
        return { id: row.id, cwd: workspace, model: thread.model, cliVersion: row.cliVersion };
      }
      /** @param {WorktreeOptions & { prompt: string, schema: Packet, effort?: string }} options @returns {Promise<string>} */
      async startTurn({ workspace, prompt, schema, model, effort, permissions }) {
        if (!this.#threadId) throw failed("Codex has no accepted native thread identity");
        const accepted = object((await this.#request("turn/start", {
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
import { isAbsolute, relative, resolve } from "node:path";
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
  const modelConfig = Array.isArray(packet.configOptions) ? packet.configOptions.map(object2).find((option) => option?.category === "model" && option.type === "select") : void 0;
  const value = modelConfig?.currentValue ?? object2(packet.models)?.currentModelId;
  return nonempty2(value) ? value : void 0;
}
function permissionResult(params, plan, sessionId) {
  if (params?.sessionId !== sessionId || !sessionId) return { outcome: { outcome: "cancelled" } };
  const tool = object2(params?.toolCall);
  const withinWorktree = (location) => {
    const path = object2(location)?.path;
    if (!nonempty2(path)) return false;
    const fromWorkspace = relative(plan.workspace, resolve(plan.workspace, path));
    return !isAbsolute(fromWorkspace) && fromWorkspace !== ".." && !fromWorkspace.startsWith("../") && fromWorkspace !== ".git" && !fromWorkspace.startsWith(".git/");
  };
  const editable = plan.mode === "edit" && tool?.kind === "edit" && Array.isArray(tool.locations) && tool.locations.length > 0 && tool.locations.every(withinWorktree);
  const allow = tool?.kind === "read" || tool?.kind === "search" || editable;
  const option = Array.isArray(params?.options) ? params.options.map(object2).find((entry) => entry?.kind === (allow ? "allow_once" : "reject_once")) : void 0;
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
        packet = object2(JSON.parse(line));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new CursorAcpError("cancellation_pending", "Cursor ACP stream contains invalid JSON");
      }
      if (packet?.jsonrpc !== "2.0") throw new CursorAcpError("cancellation_pending", "Cursor ACP stream contains an invalid envelope");
      if (typeof packet.method === "string") {
        const params = object2(packet.params);
        if (typeof packet.id === "string" || typeof packet.id === "number") {
          if (packet.method === "session/request_permission") {
            if (request && params?.sessionId === sessionId) textOnlyWithoutTools = false;
            const result2 = hooks.isInterrupted() || terminal || !request ? { outcome: { outcome: "cancelled" } } : permissionResult(params, plan, sessionId);
            send({ id: packet.id, result: result2 });
          } else {
            send({ id: packet.id, error: { code: -32601, message: "Client method unavailable" } });
          }
        } else if (packet.method === "session/update" && request && params?.sessionId === sessionId) {
          const update = object2(params?.update);
          if (terminal) {
            if (update?.sessionUpdate === "available_commands_update" && !Object.hasOwn(packet, "id") && !Object.hasOwn(packet, "result") && !Object.hasOwn(packet, "error") && Array.isArray(update.availableCommands) && update.availableCommands.every((value) => {
              const command = object2(value);
              return typeof command?.name === "string" && typeof command.description === "string" && (command.input == null || typeof object2(command.input)?.hint === "string");
            })) continue;
            throw new CursorAcpError("cancellation_pending", "Cursor ACP emitted session updates after its original prompt terminal");
          }
          if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
            textOnlyWithoutTools = false;
            chunks.length = 0;
          } else if (update?.sessionUpdate === "agent_message_chunk") {
            const content = object2(update.content);
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
      const rpcError = object2(packet.error);
      const result = object2(packet.result);
      if (rpcError && request && hooks.onProviderQuota && !hooks.isInterrupted()) {
        const status = rpcError.code === 429 || object2(rpcError.data)?.statusCode === 429;
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
        const modes = object2(result.modes);
        if (plan.mode === "read" && modes?.currentModeId !== "ask") {
          if (!Array.isArray(modes?.availableModes) || !modes.availableModes.some((mode) => object2(mode)?.id === "ask")) {
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
var CURSOR_COMMAND, CURSOR_VERSION_ARGS, CursorAcpError, object2, nonempty2, cursorUsageLimitNotice;
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
    object2 = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? (
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
import { createHash as createHash2 } from "node:crypto";
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
function grokInvocationEnvironment(environment) {
  return { ...environment, GROK_MCP_AUTO_RESTART: "0" };
}
function grokInvocationFlags(args, useAcp) {
  return new Set(useAcp ? [args[0], args[1], args[4]] : args.filter((_, index) => index % 2 === 0));
}
function object3(value) {
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
        const packet = object3(JSON.parse(pieces.join("")));
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
  const meta = object3(result._meta);
  const stopReason = result.stopReason;
  if (meta?.sessionId !== identity.sessionId || meta.requestId !== identity.requestId || meta.promptId !== void 0 && meta.promptId !== identity.requestId || typeof stopReason !== "string" || !stopReasons.has(stopReason))
    throw new GrokAcpProtocolError("Grok ACP terminal differs from its original session or prompt");
  const usage = object3(meta.usage);
  const modelUsage = object3(usage?.modelUsage);
  const modelEntries = Object.entries(modelUsage ?? {});
  if (meta.usage !== void 0 && !usage || usage?.modelUsage !== void 0 && !modelUsage || stopReason === "end_turn" && !modelEntries.length || modelEntries.some(([model, value]) => !/^[a-z\d][a-z\d._:/-]*$/i.test(model) || !object3(value)))
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
    const params = object3(packet.params);
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
        const update = object3(params?.update), updateMeta = object3(params?._meta);
        const kind = update?.sessionUpdate, updateSession = params?.sessionId;
        if (typeof kind !== "string" || !kind || params?._meta !== void 0 && !updateMeta)
          throw new GrokAcpProtocolError("Grok ACP update differs from its original session or prompt");
        if (awaiting === "session/prompt" && typeof updateSession === "string" && nestedQueueSessions.has(updateSession)) continue;
        if (updateSession !== sessionId || updateMeta?.promptId !== void 0 && updateMeta.promptId !== promptId || awaiting !== "session/prompt" && (awaiting !== "session/new" || kind !== "available_commands_update"))
          throw new GrokAcpProtocolError("Grok ACP update differs from its original session or prompt");
        if (kind === "tool_call" || kind === "tool_call_update") chunks.length = 0;
        if (kind === "agent_message_chunk") {
          const content = object3(update?.content);
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
      const error = object3(packet.error);
      if (!Number.isSafeInteger(error?.code) || typeof error?.message !== "string")
        throw new GrokAcpProtocolError("Grok ACP agent returned an invalid RPC error");
      if (awaiting !== "session/prompt") throw new GrokAcpProtocolError(`Grok ACP ${awaiting} was rejected`);
      terminal = error.code === -32003 && error.message === "Rate limited" ? { ...identity, kind: "rate_limited", rpcCode: -32003, message: "Rate limited" } : { ...identity, kind: "prompt_error" };
    } else {
      const result = object3(packet.result);
      if (!result) throw new GrokAcpProtocolError("Grok ACP agent returned an invalid RPC result");
      if (awaiting === "initialize") {
        const offered = Array.isArray(result.authMethods) ? result.authMethods.map((method2) => object3(method2)?.id) : [];
        const methodId = ["cached_token", "xai.api_key"].find((method2) => offered.includes(method2));
        if (result.protocolVersion !== 1 || !methodId)
          throw new GrokAcpProtocolError("Grok ACP agent did not advertise protocol v1 with local noninteractive authentication");
        awaiting = "authenticate";
        await sendRequest(awaiting, { methodId, _meta: { headless: true } });
      } else if (awaiting === "authenticate") {
        awaiting = "session/new";
        await sendRequest(awaiting, { cwd, mcpServers: [], _meta: { sessionId, ...model === void 0 ? {} : { modelId: model } } });
      } else if (awaiting === "session/new") {
        if (result.sessionId !== sessionId || object3(result._meta)?.currentWorkingDirectory !== cwd)
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
      event = object3(JSON.parse(line));
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
      const models = Object.keys(object3(event.modelUsage) ?? {});
      if (event.sessionId !== sessionId || event.cwd !== cwd || typeof requestId !== "string" || !requestId.trim() || typeof stopReason !== "string" || !stopReason || models.some((model) => !model.trim()) || stopReason === "end_turn" && !models.length)
        throw new GrokAcpProtocolError("Grok native terminal lacks the original session, worktree, request or actual model identity");
      terminal = { sessionId, requestId, cwd, stopReason, models };
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
  const hash = createHash2("sha256"), line = Buffer.alloc(4096);
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
import { constants } from "node:os";
import { join as join2 } from "node:path";
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
    config: join2(home, ".zcode", "cli", "config.json"),
    credentialSource: join2(hostHome, ".zcode", "v2", "credentials.json"),
    credentialLink: join2(home, ".zcode", "v2", "credentials.json"),
    personal: join2(hostHome, ".zcode", "v2", "provider_config.json")
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
        const code = typeof nativeCode === "string" && Object.hasOwn(constants.errno, nativeCode) ? nativeCode : "unavailable";
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
import { realpathSync } from "node:fs";
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
  return executable ? realpathSync(executable) : void 0;
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
