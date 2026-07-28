import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

/** Start a small, bounded JSON-RPC client for the local stdio MCP server. */
export function startStdioMcpClient(serverPath, options = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let terminalError;

  function rejectPending(error) {
    terminalError ??= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes("\n")) {
      rejectPending(new Error("MCP server emitted an oversized response line"));
      child.kill("SIGTERM");
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        rejectPending(new Error("MCP server emitted malformed JSON"));
        child.kill("SIGTERM");
        return;
      }
      const entry = pending.get(response?.id);
      if (!entry) continue;
      pending.delete(response.id);
      clearTimeout(entry.timer);
      if (response.error) entry.reject(new Error(response.error.message ?? "MCP request failed"));
      else entry.resolve(response.result);
    }
  });
  child.once("error", error => rejectPending(error));
  child.once("close", (code, signal) => {
    const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
    rejectPending(new Error(`MCP server closed (${signal ?? code ?? "unknown"})${detail}`));
  });

  function request(method, params = {}) {
    if (terminalError) return Promise.reject(terminalError);
    if (!child.stdin.writable) return Promise.reject(new Error("MCP server stdin is closed"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => {
        if (!error) return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(error);
      });
    });
  }

  async function close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
    force.unref();
    await new Promise(resolve => child.once("close", resolve));
    clearTimeout(force);
  }

  return { request, close, child };
}
