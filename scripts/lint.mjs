#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const roots = ["src", "scripts", "bin", "__tests__"];
const extensions = new Set([".ts", ".mjs"]);
const failures = [];

async function walk(relative) {
  const absolute = path.join(root, relative);
  for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) await walk(child);
    else if (extensions.has(path.extname(entry.name)) || relative === "bin") await inspect(child);
  }
}

async function inspect(relative) {
  const absolute = path.join(root, relative);
  const text = await fs.readFile(absolute, "utf8");
  if (!text.endsWith("\n")) failures.push(`${relative}: missing final newline`);
  text.split("\n").forEach((line, index) => {
    if (/[ \t]+$/.test(line)) failures.push(`${relative}:${index + 1}: trailing whitespace`);
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(line)) failures.push(`${relative}:${index + 1}: dynamic code execution is forbidden`);
  });
  if (path.extname(relative) === ".mjs" || relative.startsWith("bin/")) {
    const checked = spawnSync(process.execPath, ["--check", absolute], { encoding: "utf8" });
    if (checked.status !== 0) failures.push(`${relative}: ${checked.stderr.trim() || "syntax check failed"}`);
  }
}

for (const relative of roots) {
  try { await walk(relative); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
for (const entry of await fs.readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && extensions.has(path.extname(entry.name))) await inspect(entry.name);
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Static safety lint passed.\n");
