import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
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

// Install once, in the setup, and let every test only execute the result.
// This file used to run `npm install -g` inside two separate tests into the same prefix.
// Each takes ~17s alone; under parallel suite load the second one blew a 240s test timeout,
// which is a flake that reports a false failure against an installer that worked.
beforeAll(() => {
  // Build first: the tarball packs dist/, so a stale dist would test stale bytes.
  npm(['run', 'build']);
  const out = npm(['pack', '--silent']);
  const made = out.trim().split('\n').filter((l) => l.endsWith('.tgz'));
  tarball = join(ROOT, made[made.length - 1]!.trim());
  if (!existsSync(tarball)) throw new Error(`npm pack produced no tarball (got: ${out.slice(0, 200)})`);
  prefix = mkdtempSync(join(tmpdir(), 'dot-install-'));
  npm(['install', '-g', '--no-audit', '--no-fund', tarball], { npm_config_prefix: prefix });
}, 600_000);

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
    const binDir = join(prefix, 'bin');
    expect(existsSync(binDir)).toBe(true);
    for (const b of BINS) {
      const target = join(binDir, b);
      expect(existsSync(target), `${b} not linked into the prefix bin`).toBe(true);
      const out = execFileSync(target, ['--help'], { encoding: 'utf8', timeout: 60_000 });
      expect(out).toMatch(/Usage:/);
    }
  }, 300_000);

  it('ships the bins executable, not at tsc default mode', () => {
    // Resolved through npm rather than assumed. The path used to be
    // `${prefix}/node_modules/@zeroxcyril/dot/...`, which does not exist: npm installs globals
    // under `${prefix}/lib/node_modules`. Against that wrong path the test had an
    // `if (!existsSync) return`, so it had been passing vacuously since it was written —
    // a green that measured nothing, which is the one thing this suite is supposed to refuse.
    const globalRoot = npm(['root', '--global'], { npm_config_prefix: prefix }).trim();
    const installed = join(globalRoot, '@zeroxcyril', 'dot', 'dist', 'cli', 'index.js');
    expect(existsSync(installed), `installed entry missing at ${installed} — the install layout changed and this test stopped measuring it`).toBe(true);
    const mode = execFileSync('stat', ['-c', '%a', installed], { encoding: 'utf8' }).trim();
    expect(['755', '775', '750', '770']).toContain(mode.slice(-3));
  });

  it('reports one version everywhere a version is reported', () => {
    // The manifest, `dot --version`, and the MCP initialize handshake are three separate
    // literals in three files. Nothing stops them drifting except this assertion, and a tool
    // whose install says 1.0.0 while its `--version` says 0.1.0 makes a release note wrong.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const b of ['dot', 'dot-limits']) {
      const out = execFileSync(join(prefix, 'bin', b), ['--version'], { encoding: 'utf8', timeout: 30_000 });
      expect(out.trim(), `${b} --version`).toBe(manifest.version);
    }
  });

  it('dispatches an alias to its own subcommand instead of the root help', () => {
    // `--help`, not bare: commander exits nonzero when a required option is absent,
    // which is the *correct* behaviour and would fail this test as an exception.
    const watch = execFileSync(join(prefix, 'bin', 'dot-watch'), ['--help'], { encoding: 'utf8', timeout: 30_000 });
    expect(watch).toMatch(/Usage: dot watch/);
    expect(watch).toMatch(/--targets/);
    const limits = execFileSync(join(prefix, 'bin', 'dot-limits'), [], { encoding: 'utf8', timeout: 30_000 });
    expect(limits).toMatch(/^HISTORY_RETENTION/m);
  }, 120_000);
});
