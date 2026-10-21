import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMIT_NOTES, type LimitCode } from '../src/limits.js';
import { LIMIT_STATUS, auditCoverage, countStates, renderLimitStatus, statusFor, verifyTestClaims } from '../src/commands/limits.js';

const ROOT = join(__dirname, '..');

describe('limit status taxonomy', () => {
  it('covers every catalogue code exactly once', () => {
    const audit = auditCoverage();
    expect(audit.missingStatus).toEqual([]);
    expect(audit.orphanStatus).toEqual([]);
    expect(LIMIT_STATUS).toHaveLength(LIMIT_NOTES.length);
    const codes = LIMIT_STATUS.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('uses all three states, because a two-state table would force chain physics into "fixed"', () => {
    const counts = countStates();
    expect(counts.RESOLVED).toBeGreaterThan(0);
    expect(counts.NARROWED).toBeGreaterThan(0);
    expect(counts.UNRESOLVABLE_IN_CODE).toBeGreaterThan(0);
    expect(counts.RESOLVED + counts.NARROWED + counts.UNRESOLVABLE_IN_CODE).toBe(LIMIT_STATUS.length);
  });

  it('requires every RESOLVED limit to name test files that exist and contain tests', async () => {
    const resolved = LIMIT_STATUS.filter((s) => s.state === 'RESOLVED');
    expect(resolved.length).toBeGreaterThan(0);
    for (const s of resolved) expect(s.tests.length, `${s.code} RESOLVED with no tests`).toBeGreaterThan(0);
    const v = await verifyTestClaims(ROOT);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('requires every NARROWED limit to say what still cannot be seen', () => {
    for (const s of LIMIT_STATUS.filter((x) => x.state === 'NARROWED')) {
      expect(s.remains.length, `${s.code} NARROWED with an empty "remains"`).toBeGreaterThan(20);
    }
  });

  it('states plainly why the UNRESOLVABLE ones are not code problems', () => {
    for (const s of LIMIT_STATUS.filter((x) => x.state === 'UNRESOLVABLE_IN_CODE')) {
      expect(s.change.length + s.remains.length).toBeGreaterThan(40);
    }
    // Retention is a provider decision, and the file must not imply Dot fixed it.
    const retention = statusFor('HISTORY_RETENTION');
    expect(retention?.state).toBe('UNRESOLVABLE_IN_CODE');
    expect(retention?.fix).toContain('not implemented in this build');
  });

  it('refuses to mark pre-deploy analysis resolved', () => {
    // The plan asked for RESOLVED. The residual is real: an IDL-less staged image has
    // no readable semantics, and a Buffer names no program until it lands.
    const pre = statusFor('PRE_DEPLOY_PARTIAL');
    expect(pre?.state).toBe('NARROWED');
    expect(pre?.deviation).toContain('RESOLVED');
    expect(pre?.remains).toContain('no protocol-level timelock');
  });

  it('keeps the geyser path narrowed, not resolved, while no live endpoint has been reached', () => {
    const g = statusFor('GRPC_LIVE_PATH_MOCKED');
    expect(g?.state).toBe('NARROWED');
    expect(g?.remains).toContain('handshake');
  });

  it('renders a readable table and counts that match the data', () => {
    const text = renderLimitStatus();
    expect(text).toMatch(/^Limit status — \d+ RESOLVED, \d+ NARROWED, \d+ UNRESOLVABLE_IN_CODE/);
    expect(text).toContain('## RESOLVED');
    expect(text).toContain('## UNRESOLVABLE_IN_CODE');
    const only = renderLimitStatus({ state: 'RESOLVED' });
    expect(only).toContain('## RESOLVED');
    expect(only).not.toContain('## NARROWED');
  });

  it('names test files that exist on disk, not aspirational ones', () => {
    const named = new Set<LimitCode>();
    const files = new Set<string>();
    for (const s of LIMIT_STATUS) for (const t of s.tests) {
      named.add(s.code);
      files.add(join(ROOT, t));
    }
    for (const f of files) expect(existsSync(f), `${f} named by a limit status but missing`).toBe(true);
    if (named.size > 0) {
      // And the file actually contains test bodies.
      for (const s of LIMIT_STATUS.filter((x) => x.tests.length > 0)) {
        const src = readFileSync(join(ROOT, s.tests[0]!), 'utf8');
        expect(src).toMatch(/it\(/);
      }
    }
  });
});
