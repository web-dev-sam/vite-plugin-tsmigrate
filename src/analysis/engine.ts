import { basename, relative } from "node:path";
import type {
  AnalyzerState,
  BlameSummary,
  ComponentEdge,
  ComponentGraph,
  ComponentNode,
} from "../shared/types.ts";
import { blameAnalyzer, locAnalyzer } from "./analyzers/index.ts";
import { FactStore } from "./cache.ts";
import { crawlGraph, findEntry } from "./graph.ts";
import type { AnalysisHost } from "./host.ts";

const QUEUE_CONCURRENCY = 4;

/**
 * Orchestrates crawl + analyzers + cache and produces progressive snapshots:
 * `getGraph()` returns immediately with whatever facts exist; queued work
 * (blame) fills in across subsequent polls. `version` bumps on every change
 * so clients can probe cheaply with `?since=`.
 */
export class AnalysisEngine {
  #host: AnalysisHost;
  #facts = new FactStore();
  #version = 1;
  #graphDirty = true;
  #nodes: string[] = [];
  #edges: ComponentEdge[] = [];
  #queue: Array<() => Promise<void>> = [];
  #running = 0;
  #scheduled = new Set<string>();
  #headSha: string | null = null;
  #disposed = false;

  constructor(host: AnalysisHost) {
    this.#host = host;
  }

  get version(): number {
    return this.#version;
  }

  /** Watcher hook: any project file change may alter facts and the graph. */
  invalidateFile(file: string): void {
    this.#graphDirty = true;
    this.#facts.invalidateFile(file);
    this.#version++;
  }

  /** Stop launching queued work (dev server closed). */
  dispose(): void {
    this.#disposed = true;
    this.#queue.length = 0;
  }

  async getGraph(): Promise<ComponentGraph> {
    await this.#refreshHead();
    if (this.#graphDirty) {
      const entry = await findEntry(this.#host);
      const crawl = entry ? await crawlGraph(this.#host, entry) : { nodes: [], edges: [] };
      this.#nodes = crawl.nodes;
      this.#edges = crawl.edges;
      this.#graphDirty = false;
      this.#version++;
    }
    const nodes: ComponentNode[] = [];
    for (const id of this.#nodes) {
      nodes.push(await this.#snapshotNode(id));
    }
    return {
      version: this.#version,
      complete: this.#running === 0 && this.#queue.length === 0,
      root: this.#host.root,
      nodes,
      edges: this.#edges,
    };
  }

  /** Blame facts are keyed to the commit, not file content. */
  async #refreshHead(): Promise<void> {
    let sha: string | null = null;
    try {
      sha = (await this.#host.runGit(["rev-parse", "HEAD"])).trim();
    } catch {
      sha = null;
    }
    if (sha !== this.#headSha) {
      this.#headSha = sha;
      this.#facts.invalidateKind(blameAnalyzer.name);
      this.#version++;
    }
  }

  async #snapshotNode(id: string): Promise<ComponentNode> {
    // Inline analyzer: compute on demand during the snapshot.
    let loc = this.#facts.get<number>(id, locAnalyzer.name);
    if (!loc) {
      try {
        const data = await locAnalyzer.analyze({ host: this.#host, file: id });
        loc = { state: "ready", data };
      } catch (error) {
        loc = { state: "error", error: String(error) };
      }
      this.#facts.set(id, locAnalyzer.name, loc);
      this.#version++;
    }

    // Queued analyzer: schedule once, report progressively.
    const blame = this.#facts.get<BlameSummary>(id, blameAnalyzer.name);
    if (!blame) {
      this.#enqueue(`${blameAnalyzer.name}:${id}`, async () => {
        try {
          const data = await blameAnalyzer.analyze({ host: this.#host, file: id });
          this.#facts.set(id, blameAnalyzer.name, { state: "ready", data });
        } catch (error) {
          this.#facts.set(id, blameAnalyzer.name, {
            state: "error",
            error: String(error),
          });
        }
        this.#version++;
      });
    }

    const errors: ComponentNode["errors"] = {};
    if (loc.error) {
      errors.loc = loc.error;
    }
    if (blame?.error) {
      errors.blame = blame.error;
    }
    const blameState: AnalyzerState = blame ? blame.state : "pending";
    return {
      id,
      file: relative(this.#host.root, id),
      name: basename(id, ".vue"),
      loc: loc.data ?? null,
      blame: blame?.data ?? null,
      status: { loc: loc.state, blame: blameState },
      errors,
    };
  }

  #enqueue(key: string, task: () => Promise<void>): void {
    if (this.#disposed || this.#scheduled.has(key)) {
      return;
    }
    this.#scheduled.add(key);
    this.#queue.push(async () => {
      try {
        await task();
      } finally {
        this.#scheduled.delete(key);
      }
    });
    this.#pump();
  }

  #pump(): void {
    while (this.#running < QUEUE_CONCURRENCY && this.#queue.length > 0) {
      const task = this.#queue.shift()!;
      this.#running++;
      void task().finally(() => {
        this.#running--;
        this.#pump();
      });
    }
  }
}
