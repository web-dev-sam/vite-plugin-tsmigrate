import type {
  AnalyzerState,
  BlameSummary,
  ComponentEdge,
  ComponentGraph,
} from "../shared/types.ts";
import { applyBlameAliases, blameAnalyzer, locAnalyzer } from "./analyzers/index.ts";
import { FactStore } from "./cache.ts";
import { type CrawlFile, crawlGraph, findEntries } from "./graph.ts";
import type { AnalysisHost } from "./host.ts";
import { type FileFacts, makeGraph } from "./topology.ts";
import { scoreMaintainability } from "./maintainability.ts";
import { runTypeCheck } from "./typecheck.ts";

const QUEUE_CONCURRENCY = 4;
const TYPECHECK_KEY = "typecheck";

/**
 * Orchestrates crawl + analyzers + cache and produces progressive snapshots:
 * `getGraph()` returns immediately with whatever facts exist; queued work
 * (blame, the project type-check pass) fills in across subsequent polls.
 * `version` bumps on every change so clients can probe cheaply with `?since=`.
 *
 * Each snapshot assembles two self-consistent induced graphs from the same
 * per-file facts: `vue` (`.vue` nodes, barrel-collapsed edges) and `full` (all
 * reachable modules, raw edges).
 */
export class AnalysisEngine {
  private host: AnalysisHost;
  private typeCheckCommand: string[] | false;
  private blame: boolean;
  private blameAliases: Record<string, string>;
  private facts = new FactStore();
  private _version = 1;
  private graphDirty = true;
  private vueNodes: string[] = [];
  private collapsedEdges: ComponentEdge[] = [];
  private files: CrawlFile[] = [];
  private rawEdges: ComponentEdge[] = [];
  private queue: Array<() => Promise<void>> = [];
  private running = 0;
  private scheduled = new Set<string>();
  private headSha: string | null = null;
  private disposed = false;

  // Project-wide type-check pass state (only used when enabled).
  private typeErrors = new Map<string, number>();
  private typeCheckState: AnalyzerState = "pending";
  private typeCheckError: string | undefined;
  private typeCheckDirty = true;

  /**
   * @param host analysis capabilities (resolver, reader, git) injected by the
   *   caller (Vite adapter in the plugin, canned fixtures in tests).
   * @param opts.typeCheckCommand argv for the project type-check pass, or
   *   `false` to disable it (every node reported as typed). Default disabled.
   * @param opts.blame enable per-file `git blame` (LoC per author) on the
   *   background queue. Default disabled — no git runs and blame stays empty.
   * @param opts.blameAliases map raw blame author names to canonical display
   *   names; line counts merge. Only used when `blame` is enabled.
   */
  constructor(
    host: AnalysisHost,
    {
      typeCheckCommand = false,
      blame = false,
      blameAliases = {},
    }: {
      typeCheckCommand?: string[] | false;
      blame?: boolean;
      blameAliases?: Record<string, string>;
    } = {},
  ) {
    this.host = host;
    this.typeCheckCommand = typeCheckCommand;
    this.blame = blame;
    this.blameAliases = blameAliases;
    if (typeCheckCommand === false) {
      this.typeCheckState = "ready";
      this.typeCheckDirty = false;
    }
  }

  get version(): number {
    return this._version;
  }

  /** Watcher hook: any project file change may alter facts and the graph. */
  invalidateFile(file: string): void {
    this.graphDirty = true;
    this.facts.invalidateFile(file);
    // A script/component change can change type errors project-wide; schedule
    // a re-run (the scheduled dedup coalesces bursts into a single pass).
    if (this.typeCheckCommand !== false && /\.(vue|[cm]?[jt]sx?)$/.test(file)) {
      this.typeCheckDirty = true;
    }
    this._version++;
  }

  /** Stop launching queued work (dev server closed). */
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  async getGraph(): Promise<ComponentGraph> {
    await this.refreshHead();
    // Clear the flag BEFORE awaiting the crawl: a watcher invalidation that
    // arrives mid-crawl re-arms `graphDirty` and the loop re-crawls, so the
    // returned snapshot never lags a version bump (which would make the
    // client's `?since=` probe report "unchanged" against stale data).
    while (this.graphDirty) {
      this.graphDirty = false;
      const entries = await findEntries(this.host);
      const crawl = entries.length
        ? await crawlGraph(this.host, entries)
        : { nodes: [], edges: [], files: [], rawEdges: [] };
      this.vueNodes = crawl.nodes;
      this.collapsedEdges = crawl.edges;
      this.files = crawl.files;
      this.rawEdges = crawl.rawEdges;
      this._version++;
    }

    this.scheduleTypeCheck();

    // One fact bundle per reachable file, shared by both induced graphs.
    const facts = new Map<string, FileFacts>();
    for (const { id, kind } of this.files) {
      facts.set(id, await this.fileFacts(id, kind));
    }

    const vueIds = new Set(this.vueNodes);
    const fullIds = new Set(this.files.map((file) => file.id));
    const vue = makeGraph(vueIds, adjacency(this.collapsedEdges), facts, this.host.root);
    const full = makeGraph(fullIds, adjacency(this.rawEdges), facts, this.host.root);

    return {
      version: this._version,
      complete: this.running === 0 && this.queue.length === 0,
      root: this.host.root,
      vue,
      full,
      maintainability: scoreMaintainability(full),
    };
  }

  /** Blame facts are keyed to the commit, not file content. */
  private async refreshHead(): Promise<void> {
    if (!this.blame) {
      return;
    }
    let sha: string | null = null;
    try {
      sha = (await this.host.runGit(["rev-parse", "HEAD"])).trim();
    } catch {
      sha = null;
    }
    if (sha !== this.headSha) {
      this.headSha = sha;
      this.facts.invalidateKind(blameAnalyzer.name);
      this._version++;
    }
  }

  /**
   * Ensure the single project type-check task is queued when its inputs are
   * dirty. The scheduled dedup coalesces repeated calls into one in-flight
   * pass; any invalidation during a run re-arms the dirty flag for the next.
   */
  private scheduleTypeCheck(): void {
    const command = this.typeCheckCommand;
    if (command === false || !this.typeCheckDirty || this.scheduled.has(TYPECHECK_KEY)) {
      return;
    }
    this.typeCheckDirty = false;
    this.enqueue(TYPECHECK_KEY, async () => {
      const { counts, error } = await runTypeCheck(this.host, command);
      if (error === undefined) {
        this.typeErrors = counts;
        this.typeCheckState = "ready";
        this.typeCheckError = undefined;
      } else {
        this.typeErrors = new Map();
        this.typeCheckState = "error";
        this.typeCheckError = error;
      }
      this._version++;
    });
  }

  private async fileFacts(id: string, kind: "vue" | "ts"): Promise<FileFacts> {
    // Inline analyzer: compute on demand during the snapshot.
    let loc = this.facts.get<number>(id, locAnalyzer.name);
    if (!loc) {
      try {
        const data = await locAnalyzer.analyze({ host: this.host, file: id });
        loc = { state: "ready", data };
      } catch (error) {
        loc = { state: "error", error: String(error) };
      }
      this.facts.set(id, locAnalyzer.name, loc);
      this._version++;
    }

    // Queued analyzer: schedule once, report progressively.
    const blame = this.facts.get<BlameSummary>(id, blameAnalyzer.name);
    if (this.blame && !blame) {
      this.enqueue(`${blameAnalyzer.name}:${id}`, async () => {
        try {
          const data = applyBlameAliases(
            await blameAnalyzer.analyze({ host: this.host, file: id }),
            this.blameAliases,
          );
          this.facts.set(id, blameAnalyzer.name, { state: "ready", data });
        } catch (error) {
          this.facts.set(id, blameAnalyzer.name, {
            state: "error",
            error: String(error),
          });
        }
        this._version++;
      });
    }

    // Type errors flow from the project pass. `null` while pending/errored or
    // when disabled — the client treats null as "not yet known", never red.
    const typeErrors =
      this.typeCheckState === "ready" && this.typeCheckCommand !== false
        ? (this.typeErrors.get(id) ?? 0)
        : null;

    const errors: FileFacts["errors"] = {};
    if (loc.error) {
      errors.loc = loc.error;
    }
    if (blame?.error) {
      errors.blame = blame.error;
    }
    if (this.typeCheckError !== undefined) {
      errors.typecheck = this.typeCheckError;
    }

    return {
      kind,
      loc: loc.data ?? null,
      blame: blame?.data ?? null,
      typeErrors,
      status: {
        loc: loc.state,
        blame: this.blame ? (blame ? blame.state : "pending") : "ready",
        typecheck: this.typeCheckState,
      },
      errors,
    };
  }

  private enqueue(key: string, task: () => Promise<void>): void {
    if (this.disposed || this.scheduled.has(key)) {
      return;
    }
    this.scheduled.add(key);
    this.queue.push(async () => {
      try {
        await task();
      } finally {
        this.scheduled.delete(key);
      }
    });
    this.pump();
  }

  private pump(): void {
    while (this.running < QUEUE_CONCURRENCY && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running++;
      void task().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
}

/** Adjacency map (parent → children) from an edge list. */
function adjacency(edges: ComponentEdge[]): Map<string, Set<string>> {
  const children = new Map<string, Set<string>>();
  for (const { from, to } of edges) {
    let kids = children.get(from);
    if (!kids) {
      kids = new Set();
      children.set(from, kids);
    }
    kids.add(to);
  }
  return children;
}
