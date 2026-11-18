import type {
  AnalyzerState,
  BlameSummary,
  ComponentEdge,
  ComponentGraph,
  TypeErrorMessage,
} from "../shared/types.ts";
import { applyBlameAliases, blameAnalyzer, locAnalyzer } from "./analyzers/index.ts";
import { FactStore } from "./cache.ts";
import { type CrawlFile, crawlGraph, findEntries } from "./graph.ts";
import type { AnalysisHost } from "./host.ts";
import { type FileFacts, makeGraph } from "./topology.ts";
import type { FileEvent, TypeChecker, TypeCheckResult } from "./typecheck.ts";

const QUEUE_CONCURRENCY = 4;
const TYPECHECK_KEY = "typecheck";
// Files whose change can move type errors anywhere in the project.
const TYPECHECK_INPUT = /\.(vue|[cm]?[jt]sx?)$|(^|[/\\])tsconfig[^/\\]*\.json$/;

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
  private typeChecker: TypeChecker | null;
  private blame: boolean;
  private blameAliases: Record<string, string>;
  private facts = new FactStore();
  private _version = 1;
  private graphDirty = true;
  private vueNodes: string[] = [];
  private componentEdges: ComponentEdge[] = [];
  private files: CrawlFile[] = [];
  private moduleEdges: ComponentEdge[] = [];
  private autoImportManifests: string[] = [];
  private queue: Array<() => Promise<void>> = [];
  private running = 0;
  private scheduled = new Set<string>();
  private headSha: string | null = null;
  private disposed = false;
  private inFlight: Promise<ComponentGraph> | null = null;

  // Project-wide type-check pass state (only used when enabled).
  private typeErrors = new Map<string, TypeErrorMessage[]>();
  private typeCheckState: AnalyzerState = "pending";
  private typeCheckError: string | undefined;
  private typeCheckDirty = true;
  // Bumped on every checker swap: a pass started by a retired checker must not
  // publish its (stale) result.
  private typeCheckGeneration = 0;

  /**
   * @param host analysis capabilities (resolver, reader, git) injected by the
   *   caller (Vite adapter in the plugin, canned fixtures in tests).
   * @param opts.typeChecker the project type-check pass, or `null` to disable
   *   it (every node reported as typed). Default disabled.
   * @param opts.blame enable per-file `git blame` (LoC per author) on the
   *   background queue. Default disabled — no git runs and blame stays empty.
   * @param opts.blameAliases map raw blame author names to canonical display
   *   names; line counts merge. Only used when `blame` is enabled.
   */
  constructor(
    host: AnalysisHost,
    {
      typeChecker = null,
      blame = false,
      blameAliases = {},
    }: {
      typeChecker?: TypeChecker | null;
      blame?: boolean;
      blameAliases?: Record<string, string>;
    } = {},
  ) {
    this.host = host;
    this.typeChecker = typeChecker;
    this.blame = blame;
    this.blameAliases = blameAliases;
    if (typeChecker === null) {
      this.typeCheckState = "ready";
      this.typeCheckDirty = false;
    }
  }

  get version(): number {
    return this._version;
  }

  /** Watcher hook: any project file change may alter facts and the graph. */
  invalidateFile(file: string, event: FileEvent = "change"): void {
    this.graphDirty = true;
    this.facts.invalidateFile(file);
    // A script/component change can change type errors project-wide; schedule
    // a re-run (the scheduled dedup coalesces bursts into a single pass).
    if (this.typeChecker) {
      this.typeChecker.fileChanged(file, event);
      if (TYPECHECK_INPUT.test(file)) {
        this.typeCheckDirty = true;
      }
    }
    this._version++;
  }

  /**
   * Swap the type-check pass (the tool's TS 7.1 toggle). The previous checker
   * is disposed and every node goes back to "pending" until the new checker's
   * first pass lands; `null` disables the pass.
   */
  setTypeChecker(typeChecker: TypeChecker | null): void {
    this.typeChecker?.dispose();
    this.typeChecker = typeChecker;
    this.typeCheckGeneration++;
    this.typeErrors = new Map();
    this.typeCheckError = undefined;
    this.typeCheckState = typeChecker ? "pending" : "ready";
    this.typeCheckDirty = typeChecker !== null;
    this._version++;
  }

  /** One file's type errors from the last pass; `null` while none is known. */
  typeErrorsOf(id: string): TypeErrorMessage[] | null {
    if (!this.typeChecker || this.typeCheckState !== "ready") {
      return null;
    }
    return this.typeErrors.get(id) ?? [];
  }

  /** Stop launching queued work and release the checker (dev server closed). */
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.typeChecker?.dispose();
  }

  /**
   * Snapshot entry point. Concurrent callers (an open tool tab, a second tab,
   * any other poller) share ONE in-flight pass: `buildGraph` mutates
   * engine-wide crawl state across awaits, so a re-entrant traversal would
   * skip the already-cleared `graphDirty` crawl, observe a half-assembled
   * engine (empty `files`, no LoC facts) and publish a zero-node snapshot.
   */
  getGraph(): Promise<ComponentGraph> {
    const inFlight = this.inFlight;
    if (inFlight) {
      return inFlight;
    }
    const run = this.buildGraph().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async buildGraph(): Promise<ComponentGraph> {
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
        : {
            nodes: [],
            componentEdges: [],
            files: [],
            moduleEdges: [],
            autoImportManifests: [],
          };
      this.vueNodes = crawl.nodes;
      this.componentEdges = crawl.componentEdges;
      this.files = crawl.files;
      this.moduleEdges = crawl.moduleEdges;
      this.autoImportManifests = crawl.autoImportManifests;
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
    const vue = makeGraph(vueIds, this.componentEdges, facts, this.host.root);
    const full = makeGraph(fullIds, this.moduleEdges, facts, this.host.root);

    return {
      version: this._version,
      complete: this.running === 0 && this.queue.length === 0,
      root: this.host.root,
      vue,
      full,
      autoImportManifests: this.autoImportManifests,
      typeChecker: this.typeChecker?.info ?? { ts7: false },
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
    const checker = this.typeChecker;
    if (!checker || !this.typeCheckDirty || this.scheduled.has(TYPECHECK_KEY)) {
      return;
    }
    this.typeCheckDirty = false;
    const generation = this.typeCheckGeneration;
    this.enqueue(TYPECHECK_KEY, async () => {
      let result: TypeCheckResult;
      try {
        result = await checker.check();
      } catch (error) {
        result = {
          errors: new Map(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (generation !== this.typeCheckGeneration) {
        return; // the checker was swapped mid-pass; its successor runs next
      }
      this.typeErrors = result.errors;
      this.typeCheckState = result.error === undefined ? "ready" : "error";
      this.typeCheckError = result.error;
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
      this.typeCheckState === "ready" && this.typeChecker
        ? (this.typeErrors.get(id)?.length ?? 0)
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
