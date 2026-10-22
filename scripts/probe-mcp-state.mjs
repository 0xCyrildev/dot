/**
 * Manual probe (needs a reachable RPC): does DOT_STATE_FILE change what the MCP server reports?
 *
 * Why this exists as a script rather than a test: `test/mcp.test.ts` spawns the server once in
 * beforeAll, so an environment variable that makeScout reads per call cannot be varied per test without
 * a second harness. Run it twice-a-minute against mainnet:
 *
 *   node scripts/probe-mcp-state.mjs
 *
 * Measured 2026-10-22 against api.mainnet-beta: without the file `behavior` sits in
 * `danger.unassessedAxes` and CRITICAL is withheld by the ceiling rule; with it, `behavior` leaves that
 * list. The score did not move (10/100 both ways), because a program Dot has seen before scores 0 on that
 * axis — the point is measurability, not magnitude.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PROG = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
writeFileSync('/tmp/mcp-state.json', JSON.stringify({ [PROG]: { at: Date.now() - 3_600_000, knownDependents: 0, lamportsRouted: 0, tier: 'P3' } }));

async function call(useState) {
  const env = { ...process.env, DOT_RPC_URL: 'https://api.mainnet-beta.solana.com' };
  if (useState) env.DOT_STATE_FILE = '/tmp/mcp-state.json'; else delete env.DOT_STATE_FILE;
  const p = spawn('node', ['dist/cli/index.js', 'mcp', '--mode', 'rules'], { env });
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
  let buf = '';
  const got = new Promise((res) => {
    p.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.id === 2) { buf = ''; res(j); }
        } catch { /* partial line */ }
      }
      buf = buf.split('\n').pop();
    });
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await new Promise((r) => setTimeout(r, 600));
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dot_evaluate_upgrade', arguments: { program: PROG, budget: { maxRpcCalls: 8, maxSignatures: 2, maxLlmTokens: 0, maxWallMs: 60000 } } } });
  const r = await got;
  p.kill();
  const sc = r?.result?.structuredContent ?? {};
  return { ceiling: sc.danger?.ceiling ?? null, unassessed: sc.danger?.unassessedAxes ?? null, score: sc.danger?.score ?? null };
}

console.log('without DOT_STATE_FILE:', JSON.stringify(await call(false)));
console.log('with    DOT_STATE_FILE:', JSON.stringify(await call(true)));
