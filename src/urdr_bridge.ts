import { promises as fs } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { countTokens } from "./token_budget.js";

export interface MemoryContext {
  status: "available" | "empty" | "unavailable";
  /** Historical evidence only; not proof of current code behavior. */
  leaves: Array<{ id: string; text: string; file: string }>;
  stamp?: string;
  omitted?: number;
  reason?: string;
}

export type MemoryProvider = (task: string, projectRoot: string) => Promise<MemoryContext>;

/** Explicit project-to-memory binding; never auto-discovers personal memory.
 * Only read tools are called. Urdr may maintain its own derived pack/spool. */
export function createUrdrMemoryProvider(options: {
  serverPath: string; memoryRoot: string; projectRoot: string; maxTokens?: number;
}): MemoryProvider {
  return async (task, projectRoot) => {
    const budget = options.maxTokens ?? 700;
    if (!Number.isInteger(budget) || budget < 200 || budget > 2000) throw new RangeError("Memory budget must be 200..2000");
    if (await fs.realpath(projectRoot) !== await fs.realpath(options.projectRoot)) throw new Error("Memory binding belongs to another project");
    const client = new Client({ name: "verdandi-memory-reader", version: "0.2.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [await fs.realpath(options.serverPath), "--root", await fs.realpath(options.memoryRoot)],
      stderr: "ignore",
    });
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
      const result = await client.callTool({ name, arguments: { ...args, force: true, maxReplyTokens: 2000 } }, { timeout: 10_000 });
      if (result.isError) throw new Error(`Urdr ${name} failed`);
      const value = result.structuredContent as any;
      // Do not use a JSON line fetch to expand an arbitrary oversized string.
      if (!value || value.spooled || value.unchanged) throw new Error(`Urdr ${name} requires explicit bounded retrieval`);
      return value;
    };
    try {
      await client.connect(transport, { timeout: 10_000 });
      const brief = await call("urdr_context");
      const found = await call("urdr_search", { query: task, maxResults: 3, mode: "auto" });
      const ids = (found.results ?? []).slice(0, 3).map((item: any) => item.id ?? `${item.file}#L${item.line}`);
      if (!ids.length) return { status: "empty", leaves: [], stamp: brief.stamp };
      const read = await call("urdr_read", { ids });
      const context: MemoryContext = { status: "available", leaves: [], stamp: brief.stamp, omitted: 0 };
      for (const leaf of read.leaves ?? []) {
        if (leaf.error || typeof leaf.text !== "string" || typeof leaf.id !== "string" || typeof leaf.file !== "string") continue;
        const item = { id: leaf.id, file: leaf.file, text: leaf.text };
        if (countTokens({ ...context, leaves: [...context.leaves, item], omitted: 3 }) > budget) { context.omitted!++; continue; }
        context.leaves.push(item);
      }
      // Snapshot drift during retrieval is not silently presented as one consistent memory.
      const after = await call("urdr_context");
      if (after.stamp !== brief.stamp) throw new Error("Urdr memory changed during retrieval; retry required");
      if (!context.leaves.length) context.status = "empty";
      return context;
    } catch (error) {
      return { status: "unavailable", leaves: [], reason: String(error instanceof Error ? error.message : error).slice(0, 160) };
    } finally { await client.close().catch(() => {}); }
  };
}
