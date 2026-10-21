export type EvidenceKind = 'upgrade' | 'posture' | 'trace' | 'edge' | 'limit' | 'budget';

export type Evidence = {
  /** Stable handle the report prints and the model has to cite. */
  id: string;
  kind: EvidenceKind;
  summary: string;
  ref?: {
    signature?: string;
    slot?: number;
    from?: string;
    to?: string;
    program?: string;
  };
};

/**
 * Every claim Dot makes resolves to an entry here.
 *
 * This exists for one reason: the LLM leg of the pipeline is only allowed to
 * assert things it can point at. A model answer whose citations do not resolve
 * is not "a slightly hallucinated answer", it is an unpriced guess, and Dot
 * refuses it and falls back to the rule engine, recording the refusal in the
 * report.
 */
export class EvidenceLedger {
  private readonly items = new Map<string, Evidence>();
  private n = 0;

  add(e: Omit<Evidence, 'id'>): Evidence {
    const id = `EV-${++this.n}`;
    const item: Evidence = { id, ...e };
    this.items.set(id, item);
    return item;
  }

  get(id: string): Evidence | undefined {
    return this.items.get(id);
  }

  all(): Evidence[] {
    return [...this.items.values()];
  }

  /** Ids a model was shown, so an out-of-range citation is provably invented. */
  knownIds(): string[] {
    return [...this.items.keys()];
  }

  resolveCitations(cites: string[]): { ok: string[]; bad: string[] } {
    const ok: string[] = [];
    const bad: string[] = [];
    for (const c of cites) {
      if (this.items.has(c)) ok.push(c);
      else bad.push(c);
    }
    return { ok, bad };
  }
}
