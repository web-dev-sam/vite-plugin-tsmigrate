import type { AnalysisHost } from "../host.ts";

export interface AnalyzerContext {
  host: AnalysisHost;
  /** Absolute path of the file under analysis. */
  file: string;
}

/**
 * The extension point of the analysis engine. Adding a metric (bundle cost,
 * type-safety, a11y, …) means adding one module here and wiring it into the
 * engine — nothing else changes.
 *
 * `cost` decides scheduling: `inline` runs during snapshot assembly (must be
 * cheap); `queued` runs on the bounded background queue and reports
 * progressively via the node's per-analyzer status.
 */
export interface Analyzer<T> {
  readonly name: string;
  readonly cost: "inline" | "queued";
  analyze(ctx: AnalyzerContext): Promise<T>;
}

export { applyBlameAliases, blameAnalyzer, parseBlamePorcelain } from "./blame.ts";
export { complexityAnalyzer } from "./complexity.ts";
export { locAnalyzer } from "./loc.ts";
