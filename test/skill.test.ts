import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The skill package, checked as an artifact rather than as prose.
 *
 * A skill is the layer where an agent learns *when* to reach for the tool and *how* to
 * read what comes back. The failure it has to prevent is specific: an agent that has
 * only seen successful scans will report an empty range as a clean one. So this test
 * asserts the four kinds of "nothing" are actually spelled out, that the escalation
 * exit codes are documented, and that the shipped example is a real report — including
 * a failure — not a curated success.
 */

const SKILL_DIR = join(__dirname, '..', 'skill', 'dot');
const ROOT = join(__dirname, '..');
const SKILL = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');

function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) throw new Error('SKILL.md has no YAML frontmatter block');
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1] as string] = (kv[2] as string).trim().replace(/^"|"$/g, '');
  }
  return out;
}

const fm = frontmatter(SKILL);

describe('skill package layout', () => {
  it('has the files the pashov skills format expects', () => {
    for (const f of ['SKILL.md', 'README.md']) expect(existsSync(join(SKILL_DIR, f)), f).toBe(true);
    expect(existsSync(join(SKILL_DIR, 'references'))).toBe(true);
  });

  it('parses frontmatter with the required keys', () => {
    expect(fm.name).toBe('dot');
    expect(fm.description).toBeDefined();
    expect(fm.description.length).toBeGreaterThan(200);
    expect(fm.paths).toBeDefined();
    expect(fm.paths).toMatch(/\*\*/);
  });

  it('names trigger phrases in the description so a router can match them', () => {
    const triggers = fm.description.match(/'[^']+'/g) ?? [];
    expect(triggers.length).toBeGreaterThanOrEqual(5);
    const joined = triggers.join(' ').toLowerCase();
    for (const phrase of ['blast radius', 'depends on this program', 'upgrade']) {
      expect(joined, `no trigger for "${phrase}"`).toContain(phrase);
    }
  });

  it('documents the three layers, and says what each is for', () => {
    expect(SKILL).toContain('dot analyze');
    expect(SKILL).toContain('dot watch');
    expect(SKILL).toContain('dot blast-radius');
    expect(SKILL).toMatch(/ecosystem/i);
  });
});

describe('coverage honesty in the skill', () => {
  it('teaches the four kinds of nothing, which is the whole reason the skill exists', () => {
    expect(SKILL).toMatch(/How to read coverage honestly/i);
    for (const kind of ['No scan ran', 'Range empty', 'Target not matched', 'clean']) {
      expect(SKILL, `missing the "${kind}" case`).toContain(kind);
    }
    // And states the failure explicitly, not just in a table.
    expect(SKILL).toMatch(/empty range as a clean one/i);
  });

  it('keeps severity and confidence separate, and names the integrity halt', () => {
    expect(SKILL).toMatch(/confidence.{0,40}not severity/is);
    expect(SKILL).toContain('tierSource');
    expect(SKILL).toContain('integrity');
  });

  it('documents the escalation ask and its distinct exit codes', () => {
    expect(SKILL).toContain('needs_more_budget');
    expect(SKILL).toContain('--budget-rpc');
    expect(SKILL).toMatch(/exit \*?\*?4/);
    expect(SKILL).toMatch(/Exit 3|exit 3/);
  });

  it('names the MCP tools the skill tells an agent to call', () => {
    for (const t of ['dot_blast_radius', 'dot_evaluate_upgrade', 'dot_limits', 'dot_watch_status']) {
      expect(SKILL).toContain(t);
    }
  });

  it('carries the unfixable limits rather than implying the tool closes them', () => {
    for (const code of ['HISTORY_RETENTION', 'VALUE_IS_PROXY', 'PDA_HOLDINGS_NOT_ENUMERATED', 'NO_MALICE_DETECTION']) {
      expect(SKILL).toContain(code);
    }
  });
});

describe('references are real artifacts', () => {
  it('ships a genuine report, including one that failed to see anything', () => {
    const p = join(SKILL_DIR, 'references', 'live-run-2026-10-21.json');
    expect(existsSync(p)).toBe(true);
    const r = JSON.parse(readFileSync(p, 'utf8')) as {
      schema: string;
      cappedBy: string;
      confidence: string;
      program: string;
      rpc: { rpcErrorCodes: Record<string, number> };
    };
    expect(r.schema).toBe('dot.report.v1');
    // The honest part: this artifact is kept because it shows a refusal, not a win.
    expect(r.cappedBy).toMatch(/retrievable/);
    expect(r.confidence).toBe('low');
    expect(r.rpc.rpcErrorCodes['-32015']).toBeGreaterThan(0);
  });

  it('explains how to read it, field by field, in order', () => {
    const p = join(SKILL_DIR, 'references', 'reading-a-report.md');
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('stoppedAt');
    expect(text).toContain('cappedBy');
    expect(text).toContain('attributionQuality');
    expect(text).toMatch(/upper bound/);
    // And names the misreading it is trying to stop.
    expect(text).toMatch(/this program is fine/i);
  });
});

describe('no unverified claims', () => {
  it('prints an npm install line only because the package is published, and pins its version', () => {
    // This test used to assert the opposite: it forbade `npm install -g @zeroxcyril/dot` and
    // required the docs to say "not published", because the registry had never accepted a publish.
    // @zeroxcyril/dot@1.0.0 went out on 2026-10-22 and the install + npx forms were both executed
    // against the registry, so the guard flips to the thing that can still rot: a document that
    // quotes a version the package no longer has. The registry itself is not queried here — the
    // suite is offline by design — so this checks doc/manifest agreement, and docs/blocked.md §1
    // records the command that proves the published state (npm view @zeroxcyril/dot version).
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    for (const f of ['SKILL.md', 'README.md']) {
      const text = readFileSync(join(SKILL_DIR, f), 'utf8');
      expect(text).toMatch(/npm install -g @zeroxcyril\/dot/);
      expect(text).not.toMatch(/not published to npm|no credentials, so no line here claims/);
      for (const quoted of text.match(/@zeroxcyril\/dot@(\d+\.\d+\.\d+)/g) ?? []) {
        expect(quoted, `${f} quotes a version that is not the manifest's`).toBe(`@zeroxcyril/dot@${manifest.version}`);
      }
      for (const tgz of text.match(/zeroxcyril-dot-(\d+\.\d+\.\d+)\.tgz/g) ?? []) {
        expect(tgz).toBe(`zeroxcyril-dot-${manifest.version}.tgz`);
      }
    }
    // And the publish claim in the root README matches the same version.
    const rootReadme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(rootReadme).toContain('Published as `@zeroxcyril/dot@1.0.0`');
  });

  it('states plainly that the geyser path was never run live', () => {
    const combined = readFileSync(join(SKILL_DIR, 'README.md'), 'utf8');
    expect(combined).toMatch(/no\s+Yellowstone endpoint has been reached live/i);
  });
});
