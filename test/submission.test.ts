import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Buffer } from 'node:buffer';
import { PublicKey } from '@solana/web3.js';
import { buildServer } from '../src/mcp/server.js';
import { countStates } from '../src/commands/limits.js';
import { LIMIT_NOTES } from '../src/limits.js';
import { BPF_LOADER_UPGRADEABLE } from '../src/ids.js';
import { txFixture } from './helpers.js';
import type { WireGetTransactionResult } from '../src/rpc/wire.js';

/**
 * The submission is checked as an artifact.
 *
 * Two failure modes this guards against: a section quietly disappearing during an
 * edit, and a documented response shape drifting from what the tool actually returns.
 * So the MCP example is not asserted against a pasted object — a stub RPC serves a
 * captured mainnet transaction, the real tool runs against it, and the keys quoted in
 * `docs/SUBMISSION.md` are checked against the live response.
 */

const ROOT = join(__dirname, '..');
const DOC = readFileSync(join(ROOT, 'docs/SUBMISSION.md'), 'utf8');
const TARGET = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

let server: Server;
let endpoint = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body) as { method: string; params: unknown[] };
      const tx = txFixture('tx-nested') as WireGetTransactionResult & Record<string, unknown>;
      const programData = (() => {
        const [pda] = PublicKey.findProgramAddressSync(
          [new PublicKey(TARGET).toBuffer()],
          new PublicKey(BPF_LOADER_UPGRADEABLE),
        );
        return pda.toBase58();
      })();
      const head = Buffer.concat([
        Buffer.from([3, 0, 0, 0]),
        (() => {
          const b = Buffer.alloc(8);
          b.writeBigUInt64LE(423_977_638n);
          return b;
        })(),
        Buffer.from([1]),
        new PublicKey('JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd').toBuffer(),
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 3, 5, 8]),
      ]);
      let result: unknown;
      if (msg.method === 'getAccountInfo') {
        const address = (msg.params as [string])[0];
        result = address === programData
          ? { context: { slot: 459_628_002 }, value: { lamports: 12_633_600, owner: BPF_LOADER_UPGRADEABLE, executable: false, data: [head.toString('base64'), 'base64'] } }
          : { context: { slot: 459_628_002 }, value: null };
      } else if (msg.method === 'getSignaturesForAddress') {
        result = [{ signature: tx.transaction.signatures[0], slot: tx.slot, err: null, blockTime: tx.blockTime, confirmationStatus: 'finalized' }];
      } else if (msg.method === 'getTransaction') {
        result = tx;
      } else {
        result = null;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server?.close());

describe('submission document', () => {
  it('contains the five required sections in order', () => {
    const headings = [...DOC.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
    // The five required sections must all be present, numbered and in order. Extra
    // sections are allowed; a missing or misnumbered one is not.
    const numbers = headings.map((h) => Number(h.split('.')[0]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    const joined = headings.join('\n');
    for (const required of [/reproduction/i, /contradiction/i, /different|static analyzer/i, /does not see/i, /MCP integration/i]) {
      expect(joined, `missing a section matching ${required}`).toMatch(required);
    }
  });

  it('shows a graph with dependents and a value figure in section 1', () => {
    const section = DOC.split(/^## /m)[1] ?? '';
    expect(section).toMatch(/index\.js replay|--fixture/);
    expect(section).toMatch(/depth 2\s+\S+ -> \S+/);
    expect(section).toContain('Direct dependents');
    expect(section).toMatch(/lamports=\d+/);
    // And does not let the example pass for a sweep.
    expect(section).toMatch(/not a sweep/i);
  });

  it('keeps the three chain contradictions present and links the lessons document', () => {
    expect(DOC).toContain('StructError');
    expect(DOC).toMatch(/jsonParsed/);
    expect(DOC).toContain('ELF magic');
    expect(DOC).toContain('docs/lessons.md');
    expect(existsSync(join(ROOT, 'docs/lessons.md'))).toBe(true);
  });

  it('links blocked/unverified claims instead of asserting success', () => {
    expect(DOC).toContain('docs/blocked.md');
    expect(DOC).toMatch(/not implemented/);
    expect(DOC).toMatch(/never been exercised against a live/);
    // No fabricated dollar figure anywhere in the pitch.
    expect(DOC).not.toMatch(/\$\d+(?:,\d{3})+M/);
  });

  it('lists limits in three states with counts that match the data', () => {
    // Read the counts from the code, not from the prose. An earlier version of this
    // test hardcoded "7 NARROWED / 8 UNRESOLVABLE" and went green the whole time the
    // submission was stale -- which is the exact drift this file is supposed to catch.
    const counts = countStates();
    expect(DOC).toContain(`${counts.RESOLVED} RESOLVED`);
    expect(DOC).toContain(`${counts.NARROWED} NARROWED`);
    expect(DOC).toContain(`${counts.UNRESOLVABLE_IN_CODE} UNRESOLVABLE_IN_CODE`);
    expect(counts.RESOLVED + counts.NARROWED + counts.UNRESOLVABLE_IN_CODE).toBe(LIMIT_NOTES.length);
  });
});

describe('the documented MCP response is the real response', () => {
  it('dot_blast_radius returns exactly the structuredContent keys the submission quotes', async () => {
    const mcp = buildServer({ mode: 'rules' });
    const client = new Client({ name: 'submission-test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(b), client.connect(a)]);
    const res = await client.callTool({
      name: 'dot_blast_radius',
      arguments: {
        program: TARGET,
        rpc: endpoint,
        budget: { maxRpcCalls: 20, maxSignatures: 10, maxLlmTokens: 0, maxWallMs: 60_000 },
        forceFullTrace: true,
      },
    });
    const sc = res.structuredContent as Record<string, unknown>;
    for (const key of [
      'tier', 'tierSource', 'score', 'confidence', 'stoppedAt', 'cappedBy', 'decisionSource',
      'directCallers', 'transitiveCallers', 'lamportsRouted', 'valueIsProxy',
      'attributionQuality', 'integrity', 'budget', 'limits',
    ]) {
      expect(sc, `structuredContent.${key} missing`).toHaveProperty(key);
    }
    // The proxy label is a constant in the payload, not a hope about the reader.
    expect(sc.valueIsProxy).toBe(true);
    // A single captured transaction: attribution must be exact, not flattened.
    expect(sc.attributionQuality).toBe('stackHeight');
    expect(Array.isArray(sc.limits)).toBe(true);
    expect((sc.limits as string[]).length).toBeGreaterThan(0);
    expect(sc.decisionSource).toBe('rules');

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'dot_blast_radius', 'dot_evaluate_upgrade', 'dot_limits', 'dot_watch_status',
    ]);
    for (const t of tools.tools.filter((x) => x.name === 'dot_blast_radius' || x.name === 'dot_evaluate_upgrade')) {
      expect((t.inputSchema as { required?: string[] }).required).toContain('budget');
    }
  });
});
