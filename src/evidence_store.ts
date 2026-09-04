import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { contentHash } from "./safe_files.js";
import { boundedPrefix, countTokens, TOKEN_ENCODING } from "./token_budget.js";

export interface EvidenceRecord {
  version: 1;
  kind?: "source" | "delta";
  project: string;
  file: string;
  snapshot: string;
  hash: string;
  text: string;
  symbol?: string;
}

export interface ReadEvidenceInput {
  projectRoot: string;
  file?: string;
  symbol?: string;
  ref?: string;
  offset?: number;
  maxTokens?: number;
  /** Explicit caller acknowledgement of the COMPLETE artifact in its current context. */
  knownRef?: string;
  previousRef?: string;
}

export interface EvidencePage {
  kind: "source" | "delta";
  ref: string;
  file: string;
  snapshot: string;
  hash: string;
  offset: number;
  nextOffset: number;
  totalChars: number;
  source: string;
  done: boolean;
  unchanged?: boolean;
  encoding: typeof TOKEN_ENCODING;
  tokenCount: number;
}

const REF = /^ev_[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;

async function directoryFor(root: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  let directory = realRoot;
  for (const component of [".verdandi", "evidence"]) {
    directory = path.join(directory, component);
    await fs.mkdir(directory, { recursive: true });
    const st = await fs.lstat(directory);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Unsafe evidence directory");
  }
  return directory;
}

/** Immutable, root-bound evidence. No automatic eviction of active references. */
export async function storeEvidence(record: EvidenceRecord): Promise<string> {
  const data = JSON.stringify(record);
  if (Buffer.byteLength(data) > MAX_ARTIFACT_BYTES) throw new RangeError("Evidence artifact exceeds 8 MiB");
  const ref = `ev_${contentHash(data)}`;
  const directory = await directoryFor(record.project);
  const target = path.join(directory, `${ref}.json`);
  try {
    await fs.lstat(target);
    // Never trust an existing file based only on its name.
    await loadEvidence(record.project, ref);
    return ref;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let bytes = 0;
  for (const entry of await fs.readdir(directory)) {
    if (entry.endsWith(".json")) bytes += (await fs.lstat(path.join(directory, entry))).size;
  }
  if (bytes + Buffer.byteLength(data) > MAX_STORE_BYTES) {
    throw new RangeError("Evidence store is full; preserve active references before archiving completed tasks");
  }
  const temporary = path.join(directory, `.tmp-${randomBytes(12).toString("hex")}`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return ref;
}

export async function loadEvidence(projectRoot: string, ref: string): Promise<EvidenceRecord> {
  if (!REF.test(ref)) throw new RangeError("Invalid evidence reference");
  const root = await fs.realpath(projectRoot);
  const target = path.join(await directoryFor(root), `${ref}.json`);
  const st = await fs.lstat(target);
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_ARTIFACT_BYTES) throw new Error("Unsafe evidence artifact");
  const data = await fs.readFile(target, "utf8");
  if (`ev_${contentHash(data)}` !== ref) throw new Error("Evidence integrity failure");
  const record = JSON.parse(data) as EvidenceRecord;
  if (record.version !== 1 || record.project !== root || typeof record.text !== "string" || record.hash !== contentHash(record.text)) {
    throw new Error("Evidence belongs to another project or is invalid");
  }
  return record;
}

export function evidencePage(record: EvidenceRecord, ref: string, input: ReadEvidenceInput): EvidencePage {
  const limit = input.maxTokens ?? 1200;
  if (!Number.isInteger(limit) || limit < 300 || limit > 4000) throw new RangeError("maxTokens must be 300..4000");
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > record.text.length ||
      (offset > 0 && /[\uD800-\uDBFF]/.test(record.text[offset - 1]))) throw new RangeError("Invalid evidence offset");
  const unchanged = input.knownRef === ref && offset === 0;
  const make = (source: string): EvidencePage => {
    const nextOffset = unchanged ? record.text.length : offset + source.length;
    const page: EvidencePage = {
      kind: record.kind ?? "source", ref, file: record.file, snapshot: record.snapshot, hash: record.hash,
      offset, nextOffset, totalChars: record.text.length, source,
      done: nextOffset === record.text.length,
      ...(unchanged ? { unchanged: true } : {}), encoding: TOKEN_ENCODING, tokenCount: 0,
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      const measured = countTokens(page);
      if (page.tokenCount === measured) return page;
      page.tokenCount = measured;
    }
    throw new Error("Token counter did not stabilize");
  };
  const source = unchanged ? "" : boundedPrefix(record.text.slice(offset), part => countTokens(make(part)) <= limit);
  const page = make(source);
  if (countTokens(page) > limit || (!unchanged && !page.done && source.length === 0)) {
    throw new RangeError("Token budget cannot fit evidence metadata plus one code point");
  }
  return page;
}
