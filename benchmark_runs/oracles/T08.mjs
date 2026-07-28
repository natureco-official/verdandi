#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node T08.mjs <worktree-root>");

const packages = ["express", "fastify", "hono", "node"];
let totalBytes = 0;
const checked = [];

for (const name of packages) {
  const packageRoot = path.join(root, "packages/middleware", name);
  const declarationPath = path.join(packageRoot, "dist/index.d.mts");
  const [manifestText, declaration, config, declarationStat] = await Promise.all([
    readFile(path.join(packageRoot, "package.json"), "utf8"),
    readFile(declarationPath, "utf8"),
    readFile(path.join(packageRoot, "tsdown.config.ts"), "utf8"),
    stat(declarationPath),
  ]);
  if (!declarationStat.isFile() || declarationStat.size === 0 || declarationStat.size > 64 * 1024) {
    throw new Error(`${name}: declaration size is outside 1..65536 bytes`);
  }
  totalBytes += declarationStat.size;
  if (!/external\s*:/.test(config) || !config.includes("@modelcontextprotocol/server")) {
    throw new Error(`${name}: @modelcontextprotocol/server is not externalized`);
  }
  if (/from\s+["']@modelcontextprotocol\/core["']/.test(declaration)) {
    throw new Error(`${name}: private @modelcontextprotocol/core leaked into the public declaration`);
  }
  if (/(?:\.\.\/)+(?:server|core)\/src|packages\/(?:server|core)\/src/.test(declaration)) {
    throw new Error(`${name}: workspace source graph leaked into the public declaration`);
  }

  const manifest = JSON.parse(manifestText);
  const publishedDependencies = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  };
  const imports = [...declaration.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
  for (const specifier of new Set(imports)) {
    if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (!(packageName in publishedDependencies)) {
      throw new Error(`${name}: public import '${packageName}' is absent from dependencies/peerDependencies`);
    }
  }
  checked.push({ name, bytes: declarationStat.size, imports: [...new Set(imports)] });
}

if (totalBytes > 128 * 1024) throw new Error(`declaration bundle total exceeds 128 KiB: ${totalBytes}`);
console.log(JSON.stringify({ passed: true, totalBytes, packages: checked }));
