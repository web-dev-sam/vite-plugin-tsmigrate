/** A computed analyzer result for one file. */
export interface Fact<T> {
  state: "ready" | "error";
  data?: T;
  error?: string;
}

/**
 * In-memory fact store keyed by (file, analyzer). Invalidation granularity:
 * per file (watcher events) or per analyzer kind (e.g. every blame fact when
 * HEAD moves). Swappable for a persistent store without touching the engine.
 */
export class FactStore {
  #facts = new Map<string, Map<string, Fact<unknown>>>();

  get<T>(file: string, kind: string): Fact<T> | undefined {
    // The store is heterogeneous by design; the engine always pairs a kind
    // with its analyzer's result type.
    const fact = this.#facts.get(file)?.get(kind) as Fact<T> | undefined;
    return fact;
  }

  set<T>(file: string, kind: string, fact: Fact<T>): void {
    let byKind = this.#facts.get(file);
    if (!byKind) {
      byKind = new Map();
      this.#facts.set(file, byKind);
    }
    byKind.set(kind, fact);
  }

  /** Drop every fact for a file (its content changed). */
  invalidateFile(file: string): void {
    this.#facts.delete(file);
  }

  /** Drop one analyzer's facts everywhere (its external input changed). */
  invalidateKind(kind: string): void {
    for (const byKind of this.#facts.values()) {
      byKind.delete(kind);
    }
  }
}
