import { createInterface } from "node:readline";
import { TypeScriptContextCompiler } from "./context_compiler.js";
import { mapContextCapsule, MCP_TOOL_NAMES, type ContextCapsuleWire } from "../mcp_tools.js";

const tools = new TypeScriptContextCompiler();
const MAX_REQUEST_LINE_BYTES = 8 * 1024 * 1024;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const SUPPORTED_LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const SERVER_INFO = { name: "verdandi-context-compiler", version: "0.2.0" } as const;
const stringField = { type: "string" } as const;
const integerField = { type: "integer" } as const;
const toolDescriptions: Record<string, string> = {
  context_capsule: "Select a compact task-specific file/symbol capsule. Start with probable_files[0]; do not automatically read every returned symbol.",
  read_symbol: "Read one symbol only when source evidence is still missing. Prefer maxTokens <= 800 and includeCallGraphNeighbors=false; avoid rereading files already inspected.",
  apply_structured_patch: "Apply an atomic symbol-level TypeScript patch with snapshot/hash preconditions and rollback support.",
  rollback_patch: "Rollback a previously applied structured patch by its opaque rollback token.",
  validate_delta: "Run approved root package scripts only. Call only after confirming the root package.json defines each requested script; keep diagnostics bounded.",
};
const toolSchemas = {
  context_capsule: { type: "object", additionalProperties: false, required: ["task", "projectRoot"], properties: {
    task: { type: "string", minLength: 1, maxLength: 20_000, pattern: ".*\\S.*" }, projectRoot: { type: "string", minLength: 1, maxLength: 4_096 },
    preferredBudgetLevel: { type: "integer", enum: [0, 1, 2, 3] }, maxModelPayloadTokens: { type: "integer", minimum: 200, maximum: 1200 },
    escalationAttempt: { type: "integer", minimum: 0, maximum: 10 }, maxEscalationAttempts: { type: "integer", minimum: 1, maximum: 10 },
  } },
  read_symbol: { type: "object", additionalProperties: false, required: ["projectRoot", "symbol"], properties: {
    projectRoot: { type: "string", minLength: 1, maxLength: 4_096 }, symbol: { type: "string", minLength: 1, maxLength: 1_024 }, fileHint: { type: "string", maxLength: 4_096 }, snapshot: { type: "string", maxLength: 128 },
    includeSignature: { type: "boolean" }, includeBody: { type: "boolean" }, includeCallGraphNeighbors: { type: "boolean" },
    maxTokens: { type: "integer", minimum: 1, maximum: 4_000 },
  } },
  apply_structured_patch: { type: "object", additionalProperties: false, required: ["projectRoot", "taskId", "snapshot", "language", "operations"], properties: {
    projectRoot: { type: "string", minLength: 1 }, taskId: { type: "string", minLength: 1 }, snapshot: { type: "string", minLength: 1 },
    language: { type: "string", enum: ["typescript"] }, dryRun: { type: "boolean" },
    operations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["operation", "file", "symbol", "precondition"], properties: {
      operation: { type: "string", enum: ["replace_function_body", "replace_symbol", "delete_symbol", "insert_before_symbol", "insert_after_symbol"] },
      file: { type: "string", minLength: 1, maxLength: 4_096 }, symbol: { type: "string", minLength: 1, maxLength: 1_024 }, newBody: { type: "string", maxLength: 8_000_000 }, replacement: { type: "string", maxLength: 8_000_000 }, content: { type: "string", maxLength: 8_000_000 },
      precondition: { type: "object", additionalProperties: false, required: ["file", "contentHash"], properties: {
        file: { type: "string", minLength: 1 }, contentHash: { type: "string", minLength: 1 }, symbol: stringField, symbolHash: stringField,
      } },
    } } },
  } },
  rollback_patch: { type: "object", additionalProperties: false, required: ["projectRoot", "rollbackToken"], properties: {
    projectRoot: { type: "string", minLength: 1 }, rollbackToken: { type: "string", pattern: "^rb_[a-f0-9]{64}$" },
  } },
  validate_delta: { type: "object", additionalProperties: false, required: ["projectRoot", "taskId", "kinds"], properties: {
    projectRoot: { type: "string", minLength: 1 }, taskId: { type: "string", minLength: 1 },
    kinds: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", enum: ["test", "lint", "typecheck", "build"] } },
    commandProfile: { type: "string", enum: ["package-scripts"] }, maxDiagnostics: { ...integerField, minimum: 1, maximum: 1000 },
    maxOutputTokens: { ...integerField, minimum: 1, maximum: 8_000 },
  } },
};

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

function reply(id: unknown, result?: unknown, error?: JsonRpcError, modern = false) {
  let responseResult = result;
  if (!error && result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const meta = record._meta && typeof record._meta === "object" && !Array.isArray(record._meta)
      ? record._meta as Record<string, unknown>
      : {};
    responseResult = {
      ...record,
      ...(modern ? { resultType: "complete" } : {}),
      _meta: { ...meta, [SERVER_INFO_META_KEY]: SERVER_INFO },
    };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result: responseResult }) })}\n`);
}

function validateToolArguments(schema: any, args: any, location = "arguments"): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return `Invalid ${location}: expected object`;
  }
  // Check required parameters
  for (const req of schema.required ?? []) {
    if (args[req] === undefined || args[req] === null) {
      return `Missing required parameter: '${req}'`;
    }
  }
  // Validate types for each property in schema
  for (const [key, prop] of Object.entries(schema.properties ?? {}) as [string, any][]) {
    const val = args[key];
    if (val === undefined || val === null) continue;
    const expectedType = prop.type;
    if (expectedType === "string" && typeof val !== "string") {
      return `Invalid type for '${key}': expected string, got ${typeof val}`;
    }
    if (expectedType === "integer" && (typeof val !== "number" || !Number.isInteger(val))) {
      return `Invalid type for '${key}': expected integer, got ${typeof val}`;
    }
    if (expectedType === "number" && typeof val !== "number") {
      return `Invalid type for '${key}': expected number, got ${typeof val}`;
    }
    if (expectedType === "boolean" && typeof val !== "boolean") {
      return `Invalid type for '${key}': expected boolean, got ${typeof val}`;
    }
    if (expectedType === "array") {
      if (!Array.isArray(val)) {
        return `Invalid type for '${key}': expected array, got ${typeof val}`;
      }
      if (prop.minItems !== undefined && val.length < prop.minItems) return `Invalid value for '${key}': expected at least ${prop.minItems} item(s)`;
      if (prop.maxItems !== undefined && val.length > prop.maxItems) return `Invalid value for '${key}': expected at most ${prop.maxItems} item(s)`;
      if (prop.uniqueItems && new Set(val.map(item => JSON.stringify(item))).size !== val.length) return `Invalid value for '${key}': duplicate items are not allowed`;
      if (prop.items) {
        for (let i = 0; i < val.length; i++) {
          const item = val[i];
          if (prop.items.type === "object") {
            const nested = validateToolArguments(prop.items, item, `${key}[${i}]`);
            if (nested) return nested;
          } else if (prop.items.type === "string" && typeof item !== "string") return `Invalid type for '${key}[${i}]': expected string, got ${typeof item}`;
          if (prop.items.enum && !prop.items.enum.includes(item)) return `Invalid value for '${key}[${i}]': ${String(item)}`;
        }
      }
    }
    if (expectedType === "object") {
      const nested = validateToolArguments(prop, val, key);
      if (nested) return nested;
    }
    if (prop.enum && !prop.enum.includes(val)) return `Invalid value for '${key}': ${String(val)}`;
    if (typeof val === "number" && prop.minimum !== undefined && val < prop.minimum) return `Invalid value for '${key}': minimum is ${prop.minimum}`;
    if (typeof val === "number" && prop.maximum !== undefined && val > prop.maximum) return `Invalid value for '${key}': maximum is ${prop.maximum}`;
    if (typeof val === "string" && prop.minLength !== undefined && val.length < prop.minLength) return `Invalid value for '${key}': must not be empty`;
    if (typeof val === "string" && prop.maxLength !== undefined && val.length > prop.maxLength) return `Invalid value for '${key}': maximum length is ${prop.maxLength}`;
    if (typeof val === "string" && prop.pattern && !(new RegExp(prop.pattern)).test(val)) return `Invalid value for '${key}': pattern mismatch`;
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) if (!(key in (schema.properties ?? {}))) return `Unknown parameter: '${key}'`;
  }
  return null;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async line => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > MAX_REQUEST_LINE_BYTES) {
    reply(null, undefined, { code: -32600, message: "Invalid Request: request is too large" });
    return;
  }
  let request: any;
  try { request = JSON.parse(line); } catch {
    reply(null, undefined, { code: -32700, message: "Parse error" });
    return;
  }
  if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    reply(request && typeof request === "object" && !Array.isArray(request) && request.id !== undefined ? request.id : null,
      undefined, { code: -32600, message: "Invalid Request" });
    return;
  }
  if (request.id !== undefined && request.id !== null && typeof request.id !== "string" && typeof request.id !== "number") {
    reply(null, undefined, { code: -32600, message: "Invalid Request" });
    return;
  }
  if (request.params !== undefined && (!request.params || typeof request.params !== "object" || Array.isArray(request.params))) {
    if (request.id !== undefined) reply(request.id, undefined, { code: -32602, message: "Invalid params: expected object" });
    return;
  }
  if (request.id === undefined) return;
  const requestedProtocolVersion = request.params?._meta?.[PROTOCOL_VERSION_META_KEY];
  if (requestedProtocolVersion !== undefined && typeof requestedProtocolVersion !== "string") {
    reply(request.id, undefined, { code: -32602, message: `Invalid params: ${PROTOCOL_VERSION_META_KEY} must be a string` });
    return;
  }
  if (requestedProtocolVersion !== undefined && requestedProtocolVersion !== MODERN_PROTOCOL_VERSION) {
    reply(request.id, undefined, {
      code: -32022,
      message: `Unsupported protocol version: ${requestedProtocolVersion}`,
      data: { requested: requestedProtocolVersion, supported: [MODERN_PROTOCOL_VERSION] },
    });
    return;
  }
  const modern = request.method !== "server/discover"
    && requestedProtocolVersion === MODERN_PROTOCOL_VERSION;
  const respond = (result?: unknown, error?: JsonRpcError) => reply(request.id, result, error, modern);
  try {
    if (request.method === "server/discover") {
      respond({
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: { tools: { listChanged: false } },
      });
    } else if (request.method === "initialize") {
      if (request.params?.protocolVersion !== undefined && typeof request.params.protocolVersion !== "string") {
        respond(undefined, { code: -32602, message: "Invalid params: protocolVersion must be a string" });
        return;
      }
      const requested = request.params?.protocolVersion;
      const protocolVersion = SUPPORTED_LEGACY_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_LEGACY_PROTOCOL_VERSIONS[0];
      respond({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    } else if (request.method === "ping") {
      respond({});
    } else if (request.method === "tools/list") {
      respond({
        tools: MCP_TOOL_NAMES.map(name => ({ name, description: toolDescriptions[name], inputSchema: toolSchemas[name] })),
        ...(modern ? { ttlMs: 60_000, cacheScope: "public" } : {}),
      });
    } else if (request.method === "tools/call") {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      const schema = toolSchemas[name as keyof typeof toolSchemas];
      if (!schema) {
        respond(undefined, { code: -32602, message: `Invalid params: Unknown tool '${String(name)}'` });
        return;
      }
      const valErr = validateToolArguments(schema, args);
      if (valErr) {
        respond(undefined, { code: -32602, message: `Invalid params: ${valErr}` });
        return;
      }
      let value: unknown;
      if (name === "context_capsule") value = mapContextCapsule(await tools.context_capsule(args), "serialize");
      else if (name === "read_symbol") value = await tools.read_symbol(args);
      else if (name === "apply_structured_patch") value = await tools.apply_structured_patch(args);
      else if (name === "rollback_patch") value = await tools.rollback_patch(args);
      else if (name === "validate_delta") value = await tools.validate_delta(args);
      else throw new Error(`Unknown tool: ${name}`);
      if (name === "context_capsule") {
        const capsule = value as ContextCapsuleWire;
        respond({
          content: [{ type: "text", text: JSON.stringify(capsule.model_payload) }],
          structuredContent: capsule.model_payload,
          _meta: { schema_version: capsule.schema_version, task_id: capsule.task_id, control: capsule.control },
        });
      } else {
        respond({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
      }
    } else respond(undefined, { code: -32601, message: `Method not found: ${request.method}` });
  } catch (error) {
    const invalidInput = error instanceof RangeError || error instanceof TypeError || (error as NodeJS.ErrnoException)?.code === "ENOENT";
    respond(undefined, invalidInput
      ? { code: -32602, message: `Invalid params: ${error instanceof Error ? error.message : String(error)}` }
      : { code: -32603, message: "Internal error" });
  }
});
