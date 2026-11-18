import { posix, win32 } from "node:path";
import type { TypeCheckerInfo, TypeErrorMessage } from "../shared/types.ts";
import type { AnalysisHost } from "./host.ts";

/**
 * The project-wide type-check pass behind each node's `typeErrors`. Two
 * checkers implement it: `commandTypeChecker` (runs `typeCheckCommand`, vue-tsc
 * by default, through `host.exec`) and the experimental TypeScript 7.1 API
 * checker in `server/ts7.ts`. Everything here is pure — parsing, diagnostic
 * grouping and the fallback policy stay unit-testable with canned input.
 */

/** Watcher event kinds, as Vite's chokidar watcher names them. */
export type FileEvent = "change" | "add" | "unlink";

/**
 * One pass's verdict. `errors` holds every file with at least one error, keyed
 * by absolute path (the graph's node ids). `error` set means the check ITSELF
 * failed (no checker, broken config, missing content mapper): `errors` is
 * then empty and must never be read as "every file passes".
 */
export interface TypeCheckResult {
  errors: Map<string, TypeErrorMessage[]>;
  error?: string;
}

export interface TypeChecker {
  /** Surfaced to the tool UI (toggle state, fallback reason). Read live. */
  readonly info: TypeCheckerInfo;
  /** Run one full pass over the project. May throw on infrastructure failure. */
  check(): Promise<TypeCheckResult>;
  /** Watcher feed for incremental checkers; one-shot commands ignore it. */
  fileChanged(file: string, event: FileEvent): void;
  /** Release processes and remote state. Idempotent. */
  dispose(): void;
}

// `tsc`/`vue-tsc --pretty false` emit one diagnostic per line —
// `path(line,col): error TSxxxx: message` — with chained detail lines indented
// beneath it.
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/;

/**
 * Group `--pretty false` errors per file. Each diagnostic path is resolved to
 * an ABSOLUTE id against `root` so it matches the graph's node ids (which are
 * absolute module ids), whether the checker printed relative or absolute paths.
 */
export function parseTscErrors(output: string, root: string): Map<string, TypeErrorMessage[]> {
  const errors = new Map<string, TypeErrorMessage[]>();
  let last: TypeErrorMessage | null = null;
  for (const line of output.split("\n")) {
    const match = ERROR_LINE.exec(line.trimEnd());
    if (match) {
      const id = toModuleId(root, match[1].trim());
      last = {
        line: Number(match[2]),
        column: Number(match[3]),
        code: Number(match[4]),
        message: match[5],
      };
      const list = errors.get(id);
      if (list) list.push(last);
      else errors.set(id, [last]);
    } else if (last && /^\s+\S/.test(line)) {
      last.message += `\n${line.trimEnd()}`;
    } else {
      last = null;
    }
  }
  return errors;
}

// Vite's module ids use forward slashes on every platform — `C:/app/src/A.vue`
// on Windows, where Node's own `resolve` would answer `C:\app\src\A.vue` and
// no diagnostic would ever match its node. Keyed off the root's shape (not the
// host OS) so both forms stay unit-testable anywhere.
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/;
function toModuleId(root: string, file: string): string {
  return WINDOWS_ROOT.test(root)
    ? win32.resolve(root, file).replaceAll("\\", "/")
    : posix.resolve(root, file);
}

/**
 * Run `command` once per pass and parse its diagnostics. A checker exits
 * nonzero precisely because it found errors, so a nonzero code with parseable
 * diagnostics is success. Only a run that produced no parseable diagnostics
 * AND failed (couldn't start, crashed, misconfigured) is an error — its
 * message is surfaced so the UI can show a type-check failure.
 */
export function commandTypeChecker(host: AnalysisHost, command: string[]): TypeChecker {
  return {
    info: { ts7: false },
    async check() {
      const { stdout, stderr, code } = await host.exec(command[0], command.slice(1));
      // Diagnostics land on stdout, but honour stderr too for tools that split them.
      const errors = parseTscErrors(`${stdout}\n${stderr}`, host.root);
      if (errors.size === 0 && code !== 0) {
        const message = (stderr || stdout).trim();
        return {
          errors: new Map(),
          error: message || `type-check command exited with code ${code}`,
        };
      }
      return { errors };
    },
    fileChanged() {},
    dispose() {},
  };
}

/**
 * The fields of a TypeScript 7.1 API diagnostic (`typescript/async`'s
 * `Diagnostic`) the grouping reads — structural, so this stays free of the
 * preview API's types.
 */
export interface Ts7Diagnostic {
  fileName?: string;
  /** `DiagnosticCategory`: 0 Warning, 1 Error, 2 Suggestion, 3 Message. */
  category: number;
  code: number;
  text: string;
  /** Zero-based. */
  startPosition?: { line: number; character: number };
  messageChain?: Ts7Diagnostic[];
}

const CATEGORY_ERROR = 1;
// Content-mapper infrastructure diagnostics (TS18065–TS18123: the mapper could
// not be resolved, started, or failed to transform) can be attached to a file,
// yet they say nothing about that file's types: the file went unchecked and
// its importers see bogus "is not a module" errors. All of them name the
// content mapper; none of the mapped Vue diagnostics do.
const CONTENT_MAPPER_FAILURE = /\bcontent mappers?\b/i;
const MAX_REPORTED_FAILURES = 5;

/**
 * Turn the TS 7.1 diagnostics of one pass into per-file errors. Only category
 * Error counts. A diagnostic without a file (config errors, `contentMappers`
 * without `runExternalCode`, an unresolvable mapper package) or a
 * content-mapper failure means the check itself failed — reported as
 * `error`, never as "all files pass".
 */
export function groupTs7Diagnostics(diagnostics: readonly Ts7Diagnostic[]): TypeCheckResult {
  const errors = new Map<string, TypeErrorMessage[]>();
  const failures = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.category !== CATEGORY_ERROR) continue;
    const message = flattenTs7Message(diagnostic);
    if (!diagnostic.fileName || CONTENT_MAPPER_FAILURE.test(message)) {
      const where = diagnostic.fileName ? `${diagnostic.fileName}: ` : "";
      failures.add(`${where}error TS${diagnostic.code}: ${message}`);
      continue;
    }
    const entry: TypeErrorMessage = {
      line: (diagnostic.startPosition?.line ?? 0) + 1,
      column: (diagnostic.startPosition?.character ?? 0) + 1,
      code: diagnostic.code,
      message,
    };
    const list = errors.get(diagnostic.fileName);
    if (list) list.push(entry);
    else errors.set(diagnostic.fileName, [entry]);
  }
  if (failures.size > 0) {
    const shown = [...failures].slice(0, MAX_REPORTED_FAILURES);
    const more = failures.size - shown.length;
    return {
      errors: new Map(),
      error: shown.join("\n") + (more > 0 ? `\n…and ${more} more` : ""),
    };
  }
  return { errors };
}

// tsc's layout for chained messages: each level indented two more spaces.
function flattenTs7Message(diagnostic: Ts7Diagnostic, depth = 0): string {
  let text = `${"  ".repeat(depth)}${diagnostic.text}`;
  for (const next of diagnostic.messageChain ?? []) {
    text += `\n${flattenTs7Message(next, depth + 1)}`;
  }
  return text;
}

/**
 * Run `primary` (the experimental TS 7.1 checker) and permanently switch to
 * `fallback` (`typeCheckCommand`) the first time it throws — not installed,
 * process crash, API drift. A *result* with `error` (broken config, missing
 * mapper) is not a throw: it is reported as a failed check so it gets fixed,
 * not silently papered over by another checker. `fallback` null
 * (`typeCheckCommand: false`) reports the throw as a failed check instead.
 */
export function withFallback(primary: TypeChecker, fallback: TypeChecker | null): TypeChecker {
  let active: TypeChecker = primary;
  let disposed = false;
  const info: TypeCheckerInfo = { ts7: true };
  return {
    info,
    async check() {
      if (active !== primary) {
        return active.check();
      }
      try {
        return await primary.check();
      } catch (error) {
        if (disposed) {
          throw error; // torn down mid-pass (toggle, restart): nobody wants a fallback run
        }
        const reason = error instanceof Error ? error.message : String(error);
        primary.dispose();
        if (!fallback) {
          // Nothing to fall back to: keep reporting the failure on every pass.
          active = failedChecker(`TypeScript 7.1 checker failed: ${reason}`);
          return active.check();
        }
        info.fallback = reason;
        active = fallback;
        return fallback.check();
      }
    },
    fileChanged(file, event) {
      active.fileChanged(file, event);
    },
    dispose() {
      disposed = true;
      primary.dispose();
      fallback?.dispose();
    },
  };
}

function failedChecker(error: string): TypeChecker {
  return {
    info: { ts7: true },
    check: async () => ({ errors: new Map(), error }),
    fileChanged() {},
    dispose() {},
  };
}
