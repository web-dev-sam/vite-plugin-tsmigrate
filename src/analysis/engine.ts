import { relative } from "node:path";
import type {
  AnalyzerState,
  BlameSummary,
  ComponentEdge,
  ComponentGraph,
  CoverageSummary,
} from "../shared/types.ts";
import {
  applyBlameAliases,
  blameAnalyzer,
  complexityAnalyzer,
  locAnalyzer,
} from "./analyzers/index.ts";
import { FactStore, type Fact } from "./cache.ts";
import { collectChurn, type FileChurn } from "./churn.ts";
import { type CrawlFile, crawlGraph, findEntries, findSourceFiles } from "./graph.ts";
import type { AnalysisHost } from "./host.ts";
import { type FileFacts, makeGraph } from "./topology.ts";
import { scoreMaintainability } from "./maintainability.ts";
import { runTypeCheck } from "./typecheck.ts";

const QUEUE_CONCURRENCY = 4;
const TYPECHECK_KEY = "typecheck";
const CHURN_KEY = "churn";
/** Max unreached files shipped on the wire — totals stay exact in sourceFiles/sourceLoc. */
const MAX_UNREACHED_WIRE = 200;

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
  private scoreTypeRisk: boolean;
  private churnEnabled: boolean;
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
  private sourceFiles: string[] = [];
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

  // Project-wide churn pass state (one bounded `git log` per involved repo).
  // Null until the first pass lands — the score then reports churnCoverage
  // null (pending) rather than a fake 0.
  private churnStats: Map<string, FileChurn> | null = null;
  private churnDirty = true;

  /**
   * @param host analysis capabilities (resolver, reader, git) injected by the
   *   caller (Vite adapter in the plugin, canned fixtures in tests).
   * @param opts.typeCheckCommand argv for the project type-check pass, or
   *   `false` to disable it (every node reported as typed). Default disabled.
   * @param opts.scoreTypeRisk include type debt in the maintainability score;
   *   `false` scores structure only (type-check still colors nodes).
   * @param opts.churn enable the project churn pass (one bounded `git log
   *   --numstat` per involved repo) feeding the score's volatility term.
   *   Default disabled — volatility stays on the structural floor.
   * @param opts.blame enable per-file `git blame` (LoC per author) on the
   *   background queue. Default disabled — no git runs and blame stays empty.
   * @param opts.blameAliases map raw blame author names to canonical display
   *   names; line counts merge. Only used when `blame` is enabled.
   */
  constructor(
    host: AnalysisHost,
    {
      typeCheckCommand = false,
      scoreTypeRisk = true,
      churn = false,
      blame = false,
      blameAliases = {},
    }: {
      typeCheckCommand?: string[] | false;
      scoreTypeRisk?: boolean;
      churn?: boolean;
      blame?: boolean;
      blameAliases?: Record<string, string>;
    } = {},
  ) {
    this.host = host;
    this.typeCheckCommand = typeCheckCommand;
    this.scoreTypeRisk = scoreTypeRisk;
    this.churnEnabled = churn;
    this.blame = blame;
    this.blameAliases = blameAliases;
    if (typeCheckCommand === false) {
      this.typeCheckState = "ready";
      this.typeCheckDirty = false;
    }
    if (!churn) {
      this.churnDirty = false;
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
      this.sourceFiles = entries.length ? await findSourceFiles(this.host) : [];
      this._version++;
    }

    this.scheduleTypeCheck();

    // One fact bundle per reachable file, shared by both induced graphs.
    const facts = new Map<string, FileFacts>();
    for (const { id, kind } of this.files) {
      facts.set(id, await this.fileFacts(id, kind));
    }

    this.scheduleChurn();

    // Crawl scope: which source files the graph covers. Unreached files get a
    // LoC readout (cached like any fact) but enter neither floor nor cost.
    // The shipped list is capped (largest first) — a monorepo sibling can hold
    // thousands of unreached files; totals stay exact via sourceFiles/sourceLoc.
    const reachable = new Set(this.files.map((file) => file.id));
    let graphLoc = 0;
    for (const { id } of this.files) {
      graphLoc += facts.get(id)?.loc ?? 0;
    }
    const unreached: CoverageSummary["unreached"] = [];
    let unreachedLoc = 0;
    for (const id of this.sourceFiles) {
      if (reachable.has(id)) {
        continue;
      }
      const loc = (await this.locFact(id)).data ?? 0;
      unreached.push({ file: relative(this.host.root, id), loc });
      unreachedLoc += loc;
    }
    unreached.sort((a, b) => b.loc - a.loc || a.file.localeCompare(b.file));
    const unreachedCount = unreached.length;
    unreached.length = Math.min(unreached.length, MAX_UNREACHED_WIRE);

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
      maintainability: scoreMaintainability(full, {
        scoreTypeRisk: this.scoreTypeRisk,
        churn: this.churnStats ?? undefined,
      }),
      coverage: {
        graphFiles: this.files.length,
        graphLoc,
        sourceFiles: this.files.length + unreachedCount,
        sourceLoc: graphLoc + unreachedLoc,
        unreached,
      },
      autoImportManifests: this.autoImportManifests,
    };
  }

  /** Blame facts and churn stats are keyed to the commit, not file content. */
  private async refreshHead(): Promise<void> {
    if (!this.blame && !this.churnEnabled) {
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
      if (this.churnEnabled) {
        this.churnDirty = true;
      }
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

  /**
   * Ensure the single project churn pass is queued when history may have
   * moved (HEAD change; submodule HEAD moves are not tracked). Reads each
   * graph file's LoC fact — already computed by the snapshot that scheduled
   * this — so relative churn divides by current maintainable size.
   */
  private scheduleChurn(): void {
    if (!this.churnEnabled || !this.churnDirty || this.scheduled.has(CHURN_KEY)) {
      return;
    }
    this.churnDirty = false;
    const locs = new Map<string, number>();
    for (const { id } of this.files) {
      locs.set(id, this.facts.get<number>(id, locAnalyzer.name)?.data ?? 0);
    }
    this.enqueue(CHURN_KEY, async () => {
      try {
        this.churnStats = await collectChurn(this.host, locs);
      } catch {
        this.churnStats = new Map(); // no usable history — structural floor
      }
      this._version++;
    });
  }

  /**
   * LoC fact with compute-on-miss — shared by graph nodes and the coverage
   * readout (unreached files get a LoC without joining the graph). Cached in
   * the fact store, so watcher invalidation applies uniformly.
   */
  private async locFact(id: string): Promise<Fact<number>> {
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
    return loc;
  }

  private async fileFacts(id: string, kind: "vue" | "ts"): Promise<FileFacts> {
    // Inline analyzers: compute on demand during the snapshot.
    const loc = await this.locFact(id);

    let cc = this.facts.get<number>(id, complexityAnalyzer.name);
    if (!cc) {
      try {
        const data = await complexityAnalyzer.analyze({ host: this.host, file: id });
        cc = { state: "ready", data };
      } catch (error) {
        cc = { state: "error", error: String(error) };
      }
      this.facts.set(id, complexityAnalyzer.name, cc);
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
    if (cc.error) {
      errors.cc = cc.error;
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
      cc: cc.data ?? null,
      blame: blame?.data ?? null,
      typeErrors,
      status: {
        loc: loc.state,
        cc: cc.state,
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
