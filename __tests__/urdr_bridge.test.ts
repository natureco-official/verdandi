import assert from "node:assert/strict";
import { it } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUrdrMemoryProvider } from "../src/urdr_bridge.js";
import { countTokens } from "../src/token_budget.js";

it("reads a real isolated Urdr tree, binds it to one project, and keeps leaf bytes unchanged", {
  skip: !process.env.VERDANDI_URDR_SERVER && "Set VERDANDI_URDR_SERVER to an installed Urdr mcp-server.mjs",
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "verdandi-urdr-bridge-"));
  try {
    const memory = path.join(root, "memory"), project = path.join(root, "project");
    await fs.mkdir(memory); await fs.mkdir(project);
    const source = "# Root-2: Technical\n\n## Billing\n\n**05.09.2026 — invoice — Round the invoice total once, after summing all lines.**\n";
    const file = path.join(memory, "root-2-technical.md");
    await fs.writeFile(file, source);
    const provider = createUrdrMemoryProvider({ serverPath: process.env.VERDANDI_URDR_SERVER!, memoryRoot: memory, projectRoot: project, maxTokens: 500 });
    const result = await provider("invoice", project);
    assert.equal(result.status, "available", JSON.stringify(result));
    assert.match(result.leaves[0].text, /Round the invoice/);
    assert.ok(countTokens(result) <= 500);
    assert.equal(await fs.readFile(file, "utf8"), source);
    await assert.rejects(() => provider("invoice", memory), /another project/);
    await fs.writeFile(file, source.replace("once", "only once"));
    const updated = await provider("invoice", project);
    assert.notEqual(updated.stamp, result.stamp);
    assert.match(updated.leaves[0].text, /only once/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
