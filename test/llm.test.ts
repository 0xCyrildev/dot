import { describe, expect, it } from 'vitest';
import { Budget } from '../src/agent/budget.js';
import { EvidenceLedger } from '../src/agent/evidence.js';
import { RuleBasedDecision } from '../src/agent/rules.js';
import { RealLlmDecision, llmConfigFromEnv, type LlmConfig } from '../src/agent/llm.js';
import type { UpgradeContext } from '../src/agent/decision.js';

const ctx: UpgradeContext = {
  program: 'P',
  programData: 'PD',
  kind: 'upgrade',
  change: { bytecodeChanged: true, authorityChanged: false, sizeChanged: true, beforeBytes: 1_000_000, afterBytes: 1_300_000 },
  authority: { before: 'A', after: 'A', posture: 'eoa' },
  history: { signaturesAvailable: null, lastAnalysisAt: null, knownDependents: null, lamportsRoutedLast: null },
  idl: { available: false },
};

type Reply = { status: number; body: unknown };

function harness(reply: () => Promise<Reply>) {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetchImpl = ((url: string, init?: { body?: string }) => {
    urls.push(url);
    bodies.push(String(init?.body ?? ''));
    return reply().then((r) =>
      r.status === 200
        ? { ok: true, status: 200, json: async () => r.body }
        : { ok: false, status: r.status, json: async () => r.body, text: async () => 'err' },
    );
  }) as unknown as typeof fetch;

  const cfg: LlmConfig = {
    baseUrl: 'http://fake.test/v1',
    apiKey: 'sk-secret-must-not-appear',
    model: 'm',
    maxOutputTokens: 200,
    fetchImpl,
  };
  const budget = new Budget({ maxLlmTokens: 4000, maxRpcCalls: 100, maxSignatures: 100 });
  const ledger = new EvidenceLedger();
  const ev = ledger.add({ kind: 'posture', summary: 'authority=FnSC… posture=eoa' });
  const engine = new RealLlmDecision(cfg, new RuleBasedDecision({}), budget);
  return { engine, budget, ledger, ev, urls, bodies, id: ev.id };
}

const ok = (content: unknown, usage = { prompt_tokens: 300, completion_tokens: 60 }): Reply => ({
  status: 200,
  body: { choices: [{ message: { content: JSON.stringify(content) } }], usage },
});

describe('RealLlmDecision is citation-gated', () => {
  it('accepts a model answer whose citations resolve, and keeps its plan', async () => {
    const h = harness(async () => ok({ proceed: true, confidence: 'high', rationale: 'EOA authority and an unobserved graph both point at a real blast radius', cites: [h.id], planned_signatures: 80 }));
    const d = await h.engine.decide(ctx, h.ledger);
    expect(d.source).toBe('llm');
    expect(d.proceed).toBe(true);
    expect(d.plan.signatures).toBe(80);
    expect(d.rejected).toBeUndefined();
    expect(d.llmTokensUsed).toBe(360);
    expect(h.budget.snapshot().spent.llmTokensSettled).toBe(360);
  });

  it('discards an answer that cites an evidence id Dot never issued', async () => {
    const h = harness(async () => ok({ proceed: false, confidence: 'high', rationale: 'claims a quiet graph that was never observed', cites: ['EV-404'] }));
    const d = await h.engine.decide(ctx, h.ledger);
    expect(d.source).toBe('rules');
    expect(d.proceed).toBe(true);
    expect(d.rejected?.reason).toMatch(/never issued/);
    expect(String(d.rejected?.detail?.bad)).toContain('EV-404');
  });

  it('mixes one good and one invented citation by discarding the whole answer, not the bad line', async () => {
    const h = harness(async () => ok({ proceed: true, confidence: 'high', rationale: 'partly grounded, partly invented', cites: [h.id, 'EV-9'] }));
    const d = await h.engine.decide(ctx, h.ledger);
    expect(d.source).toBe('rules');
    expect(d.rejected?.reason).toMatch(/1 evidence id/);
  });

  it('falls back to the rule engine when the endpoint errors, and says why', async () => {
    const h = harness(async () => ({ status: 503, body: { error: 'overloaded' } }));
    const d = await h.engine.decide(ctx, h.ledger);
    expect(d.source).toBe('rules');
    expect(d.rejected?.reason).toMatch(/LLM_UNAVAILABLE|HTTP 503/);
    expect(d.proceed).toBe(true);
  });

  it('never puts the API key in a failure message', async () => {
    const h = harness(async () => ({ status: 500, body: {} }));
    const d = await h.engine.decide(ctx, h.ledger);
    const json = JSON.stringify(d);
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('Bearer');
  });

  it('refuses to call the model at all once the token budget cannot cover the estimate', async () => {
    const h = harness(async () => ok({ proceed: true, confidence: 'high', rationale: 'should never be asked', cites: [h.id] }));
    h.budget.reserveTokens(3950);
    const d = await h.engine.decide(ctx, h.ledger);
    expect(h.urls).toHaveLength(0);
    expect(d.source).toBe('rules');
    expect(d.rejected?.reason).toMatch(/token budget refused/);
  });

  it('rejects a schema-violating reply instead of trusting a partial object', async () => {
    const h = harness(async () => ok({ proceed: 'yes', rationale: 'nope' }));
    const d = await h.engine.decide(ctx, h.ledger);
    expect(d.source).toBe('rules');
    expect(d.rejected?.reason).toMatch(/schema validation/);
  });

  it('sends a prompt that tells the model no IDL means no semantics', async () => {
    const h = harness(async () => ok({ proceed: true, confidence: 'medium', rationale: 'posture-only reading of the change', cites: [h.id] }));
    await h.engine.decide(ctx, h.ledger);
    const sent = decodeURIComponent(JSON.parse(h.bodies[0]).messages[1].content);
    expect(sent).toContain('NOT AVAILABLE');
    expect(sent).toContain('EV-1');
    expect(JSON.parse(h.bodies[0]).messages[1].content).not.toContain('sk-secret');
  });
});

describe('llmConfigFromEnv', () => {
  it('is null without a key, which is what makes mode:real degrade visibly instead of silently', () => {
    expect(llmConfigFromEnv({})).toBeNull();
    const c = llmConfigFromEnv({ DOT_LLM_API_KEY: 'k', DOT_LLM_BASE_URL: 'https://x.test/v1/' });
    expect(c?.baseUrl).toBe('https://x.test/v1');
    expect(c?.model).toBe('gpt-4o-mini');
  });
});
