import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as NodePath from 'node:path';

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(NodePath.dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Without the flush, a power loss can land the rename before the data and leave an empty file.
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flush: true });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// Resolves null when the file is missing, unreadable, malformed, or rejected by `parse`.
export async function readJsonFile<T>(
  path: string,
  parse: (value: unknown) => T,
): Promise<T | null> {
  try {
    return parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}
