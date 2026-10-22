import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * The MCP server, over a real stdio pipe.
 *
 * An in-process `InMemoryTransport` test (see `watcher-mcp.test.ts`) proves the tools
 * are registered. It cannot prove the thing that actually breaks in the field: one
 * stray `console.log` anywhere in the process interleaves with the JSON-RPC stream,
 * the host's parser chokes, and the connection drops with no useful error. So this
 * test spawns the built binary and asserts **every line on stdout is a parseable
 * JSON-RPC message**, diagnostics included — which is why they must go to stderr.
 */

// Run from source, not dist: install.test.ts runs `npm run build` in parallel with
// this suite, and a spawn racing a rebuild is a flake that teaches nothing.
const ENTRY = 'src/cli/index.ts';
let child: ChildProcessWithoutNullStreams;
const stdoutLines: string[] = [];
const stderrText: string[] = [];
let pending = new Map<number, (v: unknown) => void>();

function send(msg: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function request(id: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`no response to ${method} within 10s`));
      }
    }, 10_000);
  });
}

beforeAll(async () => {
  child = spawn('node', ['--import', 'tsx', ENTRY, 'mcp'], { cwd: process.cwd(), env: { ...process.env, NO_COLOR: '1' } });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => stderrText.push(c));
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    stdoutLines.push(trimmed);
    try {
      const msg = JSON.parse(trimmed) as { id?: number };
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)!;
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      // Recorded, not swallowed: the assertion below turns this into a failure.
    }
  });
  // Synchronize on the server's own readiness line instead of racing a timer against a
  // cold tsx start. Measured: this suite failed with "no response to initialize within 10s"
  // while install.test.ts was running `npm run build`, `npm pack` and two global installs in
  // parallel — the child was alive, just starved. A timeout tuned to an unloaded machine is
  // a flake that teaches nothing; the banner is written after `server.connect()`, so seeing
  // it means the process can answer.
  const deadline = Date.now() + 60_000;
  while (!stderrText.join('').includes('dot mcp ready')) {
    if (Date.now() > deadline) throw new Error(`child never reported ready within 60s; stderr: ${stderrText.join('').slice(0, 400)}`);
    if (child.exitCode !== null) throw new Error(`child exited with ${child.exitCode}; stderr: ${stderrText.join('').slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dot-test-client', version: '0.0.0' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 120_000);

afterAll(() => {
  child?.kill('SIGTERM');
});

describe('dot mcp over stdio', () => {
  it('answers initialize with a server identity and tool capability', async () => {
    const init = await request(11, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'second', version: '0.0.0' },
    });
    expect(init.result.serverInfo.name).toBe('dot');
    // Same version as the manifest: the MCP handshake is a third place a version literal lives,
    // and a host reads it as the identity of the server it is talking to.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(init.result.serverInfo.version).toBe(manifest.version);
    expect(init.result.capabilities.tools).toBeDefined();
  });

  it('registers all four tools via tools/list', async () => {
    const list = await request(12, 'tools/list');
    const names: string[] = list.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['dot_blast_radius', 'dot_evaluate_upgrade', 'dot_limits', 'dot_watch_status']);
    for (const t of list.result.tools as Array<{ name: string; description: string; inputSchema: { required?: string[] } }>) {
      expect(t.description.length).toBeGreaterThan(40);
      if (t.name.startsWith('dot_blast') || t.name.startsWith('dot_evaluate')) {
        expect(t.inputSchema.required).toContain('budget');
      }
    }
  });

  it('keeps stdout pure protocol bytes — the failure that kills a host connection', () => {
    const unparsable = stdoutLines.filter((l) => {
      try {
        JSON.parse(l);
        return false;
      } catch {
        return true;
      }
    });
    expect(unparsable).toEqual([]);
    expect(stdoutLines.length).toBeGreaterThan(0);
  });

  it('answers dot_limits with the three-state catalogue', async () => {
    const res = await request(13, 'tools/call', { name: 'dot_limits', arguments: {} });
    expect(res.result.isError).toBeFalsy();
    const sc = res.result.structuredContent as {
      counts: Record<string, number>;
      coverage: { missingStatus: string[]; orphanStatus: string[] };
      limits: Array<{ code: string; state: string }>;
    };
    expect(sc.limits.length).toBeGreaterThanOrEqual(20);
    expect(new Set(sc.limits.map((l) => l.state))).toEqual(new Set(['RESOLVED', 'NARROWED', 'UNRESOLVABLE_IN_CODE']));
    // A code in the catalogue with no status, or a status for a removed code, is a lie
    // waiting to be read; the tool reports the mismatch instead of hiding it.
    expect(sc.coverage.missingStatus).toEqual([]);
    expect(sc.coverage.orphanStatus).toEqual([]);
  });

  it('reports watch status as unavailable rather than inventing a cursor', async () => {
    const res = await request(14, 'tools/call', { name: 'dot_watch_status', arguments: { network: 'mainnet' } });
    const sc = res.result.structuredContent as { available: boolean; reason: string };
    expect(sc.available).toBe(false);
    expect(['no_status_file_configured', 'unreadable']).toContain(sc.reason);
  });

  it('rejects a malformed program at the schema boundary over the wire', async () => {
    const res = await request(15, 'tools/call', {
      name: 'dot_blast_radius',
      arguments: { program: 'too-short', budget: { maxRpcCalls: 5, maxSignatures: 5, maxLlmTokens: 0, maxWallMs: 5000 } },
    });
    expect(res.result.isError).toBe(true);
    expect((res.result.content as Array<{ text: string }>)[0]?.text).toMatch(/Invalid arguments|too-short/);
  });

  it('emits its ready banner on stderr, not stdout', () => {
    expect(stderrText.join('')).toMatch(/dot mcp ready/);
  });
});
