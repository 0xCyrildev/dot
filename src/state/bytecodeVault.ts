import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

/**
 * A local store for bytecode Dot has already seen.
 *
 * This exists because of one hard constraint: **after an upgrade, the previous
 * program is nowhere to be fetched.** `ProgramData` holds only the live image, the
 * staging `Buffer` may be closed by the same transaction that upgraded
 * (`close_buffer`), and core RPC has no historical account state at all —
 * `getAccountInfo`'s `minContextSlot` is a floor for staleness, not a time machine.
 *
 * So the only way to diff old against new is to have been watching. The vault is what
 * "running continuously" buys you, and it is the honest answer to a question that has
 * no RPC answer: Dot becomes stateful on purpose, and labels every diff by whether it
 * actually had the prior image or was guessing from a first sighting.
 *
 * Content-addressed by the sha256 of the image, keyed by program for lookup. Deduping
 * matters: a program whose image is unchanged across a hundred observations costs one
 * file, and the manifest keeps the *history* of which hash was live at which slot.
 */

export type VaultRecord = {
  program: string;
  programData: string;
  digest: string;
  bytes: number;
  /** Slot the node reported for the account read, when known. */
  slot: number | null;
  observedAt: number;
  source: 'watch' | 'replay' | 'operator';
};

export type VaultIndex = {
  records: VaultRecord[];
  /** program → ordered digests, oldest first, as Dot saw them */
  history: Record<string, string[]>;
};

export class BytecodeVault {
  private index: VaultIndex = { records: [], history: {} };
  private loaded = false;

  constructor(private readonly dir: string) {}

  private get indexPath(): string {
    return join(this.dir, 'index.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      this.index = JSON.parse(await readFile(this.indexPath, 'utf8')) as VaultIndex;
    } catch {
      this.index = { records: [], history: {} };
    }
    this.loaded = true;
  }

  async put(
    rec: Omit<VaultRecord, 'digest' | 'bytes'> & { image: Buffer },
  ): Promise<{ digest: string; stored: boolean }> {
    await this.load();
    const { image, ...meta } = rec;
    const digest = createHash('sha256').update(image).digest('hex');
    await mkdir(join(this.dir, 'images'), { recursive: true });
    const already = this.index.records.some((r) => r.digest === digest);
    if (!already) await writeFile(join(this.dir, 'images', `${digest}.bin`), image);
    const bytes = image.length;
    // A re-observation of the same image for a different program is still recorded:
    // two programs shipping identical bytecode is a supply-chain fact, not a duplicate.
    this.index.records.push({ ...meta, digest, bytes });
    const hist = this.index.history[meta.program] ?? [];
    if (hist[hist.length - 1] !== digest) hist.push(digest);
    this.index.history[meta.program] = hist.slice(-64);
    await writeFile(this.indexPath, JSON.stringify(this.index, null, 2));
    return { digest, stored: !already };
  }

  async get(digest: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.dir, 'images', `${digest}.bin`));
    } catch {
      return null;
    }
  }

  /** The most recently stored image for a program *other than* `exclude`, if any. */
  async priorFor(program: string, excludeDigest: string): Promise<{ record: VaultRecord; image: Buffer } | null> {
    await this.load();
    const hist = this.index.history[program] ?? [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const d = hist[i]!;
      if (d === excludeDigest) continue;
      const image = await this.get(d);
      if (!image) continue;
      const record = this.index.records.find((r) => r.digest === d && r.program === program);
      if (record) return { record, image };
    }
    return null;
  }

  async history(program: string): Promise<string[]> {
    await this.load();
    return this.index.history[program] ?? [];
  }

  size(): number {
    return this.index.records.length;
  }

  /** Distinct programs sharing one image — the identical-bytecode supply-chain link. */
  async sharedImages(): Promise<Array<{ digest: string; programs: string[] }>> {
    await this.load();
    const byDigest = new Map<string, Set<string>>();
    for (const r of this.index.records) {
      const set = byDigest.get(r.digest) ?? new Set<string>();
      set.add(r.program);
      byDigest.set(r.digest, set);
    }
    return [...byDigest.entries()]
      .filter(([, s]) => s.size > 1)
      .map(([digest, s]) => ({ digest, programs: [...s] }))
      .sort((a, b) => b.programs.length - a.programs.length);
  }
}

export async function listVaultDirs(dir: string): Promise<{ images: number; records: number }> {
  try {
    const names = await readdir(join(dir, 'images'));
    const idx = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as VaultIndex;
    return { images: names.length, records: idx.records.length };
  } catch {
    return { images: 0, records: 0 };
  }
}
