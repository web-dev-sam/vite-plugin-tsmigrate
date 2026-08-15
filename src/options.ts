import { DEFAULT_TOOL_PORT } from "./constants.ts";

/**
 * Options for the `tsmigrate` plugin factory.
 */
export interface TsMigrateOptions {
  /**
   * Log the tool URL through Vite's logger once the dev server is listening.
   *
   * @default true
   */
  logOnStart?: boolean;

  /**
   * Port for the plugin's own tool server (dev only). When the port is taken,
   * an ephemeral port is used instead. Pass `0` to always use an ephemeral
   * port.
   *
   * @default 7357
   */
  toolPort?: number;

  /**
   * Command (argv array) run once for the project-wide TypeScript pass whose
   * per-file error counts drive node coloring in the tool. It is expected to
   * emit `tsc`-style `--pretty false` diagnostics; a nonzero exit with
   * diagnostics is normal. Pass `false` to disable the pass entirely — every
   * node is then reported as typed and `status.typecheck` stays `"ready"`.
   *
   * @default ["vue-tsc", "--noEmit", "--pretty", "false"]
   */
  typeCheckCommand?: string[] | false;

  /**
   * Score type risk. Types are a cost *discount* in the model — the compiler
   * carries most re-verification wherever code is typed, so files with type
   * errors pay full price for their flaws while typed files pay a fraction.
   * `false` treats every file as typed: "score the structure as if the
   * migration were finished" — the post-migration structural ceiling, on the
   * same scale as typed repos. The type-check pass still runs and drives
   * node coloring and the typed % readout either way. With the bounded
   * discount there is no reason for mid-migration projects to turn this
   * off — reach for it only to see the ceiling.
   *
   * @default true
   */
  scoreTypeRisk?: boolean;

  /**
   * Feed real git churn into the maintainability score's volatility term
   * (one bounded `git log --numstat` per repository involved — submodules
   * are resolved per file). Measures the damped deleted-lines-per-month rate
   * of every graph file; costs a few git processes per crawl, re-run only
   * when HEAD moves. Without usable history (no repo, shallow clone)
   * volatility bottoms out at a structural floor, and the tool's churn
   * coverage readout shows how much of the graph is actually measured.
   * `false` skips the pass entirely.
   *
   * @default true
   */
  churn?: boolean;

  /**
   * Enable per-file `git blame` analysis (lines of code per author), surfaced
   * in the tool. Runs `git blame` per reachable file on the background queue,
   * so it costs one git process per file and needs real commit history (a
   * shallow checkout has none). Off by default.
   *
   * @default false
   */
  blame?: boolean;

  /**
   * Map raw `git blame` author names onto canonical display names, merging
   * their line counts in the tool's blame rollup (e.g. collapse an old git
   * handle and a full name that are the same person). Only applies when
   * `blame` is enabled; unmapped authors pass through untouched.
   *
   * @default {}
   * @example { "web-dev-sam": "Sam", "Samuel Braun": "Sam" }
   */
  blameAliases?: Record<string, string>;
}

/** All defaults applied — internals only ever see this shape. */
export type ResolvedOptions = Required<TsMigrateOptions>;

export function resolveOptions(options: TsMigrateOptions): ResolvedOptions {
  const {
    logOnStart = true,
    toolPort = DEFAULT_TOOL_PORT,
    typeCheckCommand = ["vue-tsc", "--noEmit", "--pretty", "false"],
    scoreTypeRisk = true,
    churn = true,
    blame = false,
    blameAliases = {},
  } = options;
  return { logOnStart, toolPort, typeCheckCommand, scoreTypeRisk, churn, blame, blameAliases };
}
