/**
 * Dependency-injection boundary for the analysis core.
 *
 * `analysis/` never imports from `vite` (or spawns processes itself) — the
 * server adapter provides these capabilities. Consequence: the whole engine
 * is unit-testable with in-memory fixtures and survives Vite API drift; the
 * only blast radius is `server/vite-adapter.ts`.
 */
export interface AnalysisHost {
  /** Absolute project root (the user's app). */
  root: string;
  /** Resolve an import specifier like Vite would. Null when unresolvable. */
  resolve(specifier: string, importer: string): Promise<string | null>;
  /** Read a file, null when missing/unreadable. */
  readFile(path: string): Promise<string | null>;
  /** Run git in the project root, resolving with stdout. Rejects on failure. */
  runGit(args: string[]): Promise<string>;
}
