import { DEFAULT_TOOL_PORT } from "./constants.ts";

/**
 * Options for the `tsmigrate` plugin factory.
 */
export interface TsMigrateOptions {
  /**
   * Message exposed by the `virtual:tsmigrate` module, shown in the tool UI,
   * and logged when the Vite config is resolved.
   *
   * @default "Hello, Vite 8!"
   */
  greeting?: string;

  /**
   * Log through Vite's logger: the greeting once the config is resolved, and
   * the tool URL once the dev server is listening.
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
    greeting = "Hello, Vite 8!",
    logOnStart = true,
    toolPort = DEFAULT_TOOL_PORT,
    typeCheckCommand = ["vue-tsc", "--noEmit", "--pretty", "false"],
    blame = false,
    blameAliases = {},
  } = options;
  return { greeting, logOnStart, toolPort, typeCheckCommand, blame, blameAliases };
}
