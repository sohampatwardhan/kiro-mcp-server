import { chmodSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const fakeKiro = join(repoRoot, "test/fixtures/fake-kiro.mjs");
chmodSync(fakeKiro, 0o755);

/** A fresh real-path temp directory. */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export interface MetaRecord {
  kind: string;
  argv?: string[];
  pid: number;
  method?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export function readMeta(path: string): MetaRecord[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MetaRecord);
  } catch {
    return [];
  }
}

/** Poll `check` until it returns a truthy value or `ms` passes. */
export async function waitFor<T>(check: () => T | Promise<T>, ms = 5_000, what = "condition"): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
