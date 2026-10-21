import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The install claim, tested rather than asserted.
 *
 * This exists because of a trap documented in Chase's README: `tsc` emits bin files
 * at mode 0664, npm packs whatever modes it is handed, and a global install then
 * execs a file the shell will not run. Every "it works on my checkout" check passes
 * while the shipped artifact is broken. So this test packs the tarball, installs it
 * with `npm install -g` into a throwaway prefix, and executes all six bins.
 *
 * It does not prove the package is *published* — there are no registry credentials
 * in this environment, and `docs/blocked.md` says so instead of the README printing
 * an install line that would 404.
 */

const ROOT = join(__dirname, '..');
const BINS = ['dot', 'dot-analyze', 'dot-watch', 'dot-mcp', 'dot-limits', 'dot-calibrate'];
let prefix = '';
let tarball = '';

function npm(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('npm', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
}

beforeAll(() => {
  // Build first: the tarball packs dist/, so a stale dist would test stale bytes.
  npm(['run', 'build']);
  const out = npm(['pack', '--silent']);
  const made = out.trim().split('\n').filter((l) => l.endsWith('.tgz'));
  tarball = join(ROOT, made[made.length - 1]!.trim());
  if (!existsSync(tarball)) throw new Error(`npm pack produced no tarball (got: ${out.slice(0, 200)})`);
  prefix = mkdtempSync(join(tmpdir(), 'dot-install-'));
}, 240_000);

afterAll(() => {
  if (prefix) rmSync(prefix, { recursive: true, force: true });
  for (const f of readdirSync(ROOT).filter((x) => x.endsWith('.tgz'))) rmSync(join(ROOT, f), { force: true });
});

describe('packaged install', () => {
  it('packs a tarball containing the dist and every bin target', () => {
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    expect(listing).toContain('package/dist/cli/index.js');
    expect(listing).toContain('package/README.md');
    expect(listing).toContain('package/LICENSE');
    const pkg = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })) as {
      name: string;
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.name).toBe('@zeroxcyril/dot');
    for (const b of BINS) expect(pkg.bin[b]).toBeDefined();
    // The chmod is the whole reason the shipped mode is right; assert it is in the
    // manifest, not just that this run happened to build it correctly.
    expect(pkg.scripts.postbuild).toMatch(/chmod \+x/);
  });

  it('installs globally into a clean prefix and every bin executes', () => {
    npm(['install', '-g', '--no-audit', '--no-fund', tarball], { npm_config_prefix: prefix });
    const binDir = join(prefix, 'bin');
    expect(existsSync(binDir)).toBe(true);
    for (const b of BINS) {
      const target = join(binDir, b);
      expect(existsSync(target), `${b} not linked into the prefix bin`).toBe(true);
      const out = execFileSync(target, ['--help'], { encoding: 'utf8', timeout: 60_000 });
      expect(out).toMatch(/Usage:/);
    }
  }, 240_000);

  it('ships the bins executable, not at tsc default mode', () => {
    const installed = join(prefix, 'node_modules', '@zeroxcyril', 'dot', 'dist', 'cli', 'index.js');
    if (!existsSync(installed)) return;
    const mode = execFileSync('stat', ['-c', '%a', installed], { encoding: 'utf8' }).trim();
    expect(['755', '775', '750', '770']).toContain(mode.slice(-3));
  });

  it('dispatches an alias to its own subcommand instead of the root help', () => {
    npm(['install', '-g', '--no-audit', '--no-fund', tarball], { npm_config_prefix: prefix });
    // `--help`, not bare: commander exits nonzero when a required option is absent,
    // which is the *correct* behaviour and would fail this test as an exception.
    const watch = execFileSync(join(prefix, 'bin', 'dot-watch'), ['--help'], { encoding: 'utf8', timeout: 30_000 });
    expect(watch).toMatch(/Usage: dot watch/);
    expect(watch).toMatch(/--targets/);
    const limits = execFileSync(join(prefix, 'bin', 'dot-limits'), [], { encoding: 'utf8', timeout: 30_000 });
    expect(limits).toMatch(/^HISTORY_RETENTION/m);
  }, 120_000);
});
