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
  /**
   * Entry modules declared in the build config — Vite's
   * `build.rollupOptions.input`, as set by e.g. `laravel-vite-plugin`,
   * library builds, or multi-page setups. Absolute paths. Empty when the app
   * relies on a root `index.html` instead. Used as crawl roots so apps that
   * serve their module script from outside a static `index.html` (Laravel's
   * `@vite()` in a Blade template, etc.) still produce a graph.
   */
  configuredEntries(): string[];
  /** Resolve an import specifier like Vite would. Null when unresolvable. */
  resolve(specifier: string, importer: string): Promise<string | null>;
  /**
   * Expand glob `patterns` to absolute file paths, excluding `node_modules`.
   * Relative patterns resolve against `fromDir`; a leading `/` is root-relative
   * (Vite convention). Lets the crawl follow `import.meta.glob(...)` and
   * dynamic imports with computed paths (``import(`./views/${n}.vue`)``) — the
   * modules a single specifier can't name. Empty on no match.
   */
  glob(patterns: string[], fromDir: string): Promise<string[]>;
  /** Read a file, null when missing/unreadable. */
  readFile(path: string): Promise<string | null>;
  /** Run git in the project root, resolving with stdout. Rejects on failure. */
  runGit(args: string[]): Promise<string>;
  /**
   * Run an arbitrary command in the project root. Resolves with captured
   * output and the process exit code — NEVER rejects, even on a nonzero exit
   * or a spawn failure (ENOENT etc.), so callers can inspect diagnostics that
   * tools like `tsc` emit while exiting nonzero. On spawn failure the code is
   * nonzero and the reason is in `stderr`.
   */
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}
