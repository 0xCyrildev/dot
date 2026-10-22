import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PriorDigest } from '../agent/scout.js';

/**
 * Dot's own memory of past upgrades, in one place.
 *
 * It started as a CLI file (`--state`) and is now read by the MCP server too, so the load path lives here
 * rather than as a third copy of `JSON.parse(await readFile(...))`. The shape is Dot's own writing, so
 * unparseable content is not an error to propagate: it is a program Dot has not seen before, reported as
 * such by the caller, because the behavioural axis distinguishes "no prior digest" from "no state file".
 */
export type PriorMap = Map<string, PriorDigest>;

/** Null when the file is missing or unreadable. Callers say which, because the axis reads differently. */
export async function loadPrior(path: string): Promise<PriorMap | null> {
  try {
    const loaded = JSON.parse(await readFile(path, 'utf8')) as Record<string, PriorDigest>;
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) return null;
    const out: PriorMap = new Map();
    for (const [program, digest] of Object.entries(loaded)) {
      // A digest with no `at` is worse than no digest: `priorDigestAt` would render as "Invalid Date"
      // inside a score, so the entry is dropped rather than trusted.
      if (digest && typeof digest === 'object' && typeof digest.at === 'number' && Number.isFinite(digest.at)) out.set(program, digest);
    }
    return out;
  } catch {
    return null;
  }
}

export async function savePrior(path: string, prior: PriorMap): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await writeFile(path, JSON.stringify(Object.fromEntries(prior.entries()), null, 2));
}
