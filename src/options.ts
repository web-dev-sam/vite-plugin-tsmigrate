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
   * EXPERIMENTAL. Start with the TypeScript 7.1 (beta) checker switched on,
   * instead of `typeCheckCommand`; the tool UI toggles it at runtime either
   * way. It type-checks through the TS 7.1 API with `@vue/content-mapper`
   * mapping `.vue` files — both bundled as this plugin's own dependencies, so
   * nothing extra to install — and RUNS EXTERNAL CODE: TypeScript spawns the
   * content mapper's Node process. When the checker cannot run it falls back
   * to `typeCheckCommand`.
   *
   * @default false
   */
  experimentalTs7?: boolean;

  /**
   * The tsconfig the experimental TypeScript 7.1 checker opens, relative to
   * the Vite root, when it exists. Extend your base config and declare the
   * mapper directly:
   * `"contentMappers": [{ "package": "@vue/content-mapper", "extensions": [".vue"] }]`,
   * with `noEmit`, `skipLibCheck` and an `include` that covers your `.vue` files.
   * Without it, the plugin generates that config on top of `tsconfig.app.json`
   * (else `tsconfig.json`).
   *
   * @default "tsconfig.ts7-check.json"
   */
  ts7Tsconfig?: string;

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
    experimentalTs7 = false,
    ts7Tsconfig = "tsconfig.ts7-check.json",
    blame = false,
    blameAliases = {},
  } = options;
  return {
    logOnStart,
    toolPort,
    typeCheckCommand,
    experimentalTs7,
    ts7Tsconfig,
    blame,
    blameAliases,
  };
}
