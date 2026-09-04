import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Same-directory replacement: a short write never truncates the source. */
export async function replaceFileSafely(file: string, text: string, expectedHash: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular source file: ${file}`);
  const temporary = path.join(path.dirname(file), `.verdandi-${randomBytes(12).toString("hex")}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", stat.mode & 0o777);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    if (contentHash(await fs.readFile(file, "utf8")) !== expectedHash) {
      throw new Error(`File changed before replacement: ${file}`);
    }
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

/** Fail closed for overlapping writers, including separate MCP processes.
 * A lock left by a crashed process is deliberately not stolen automatically. */
export async function withProjectMutation<T>(projectRoot: string, action: () => Promise<T>): Promise<T> {
  const root = await fs.realpath(projectRoot);
  const directory = path.join(root, ".verdandi");
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe .verdandi directory");
  const lock = path.join(directory, "mutation.lock");
  let handle;
  try { handle = await fs.open(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Project mutation is locked; finish the other writer or inspect a stale mutation.lock before recovery");
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}
