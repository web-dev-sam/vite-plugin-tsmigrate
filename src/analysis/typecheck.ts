import { resolve } from "node:path";
import type { AnalysisHost } from "./host.ts";

/**
 * Per-file TypeScript error counts from a type checker. Pure parsing plus one
 * thin runner over `host.exec` — the analysis core never spawns a process
 * itself, so this stays unit-testable with canned diagnostics.
 */

// `tsc`/`vue-tsc --pretty false` emit one diagnostic per line:
// `path(line,col): error TSxxxx: message`.
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;

/**
 * Count errors per file from `--pretty false` output. Each diagnostic path is
 * resolved to an ABSOLUTE id against `root` so it matches the graph's node ids
 * (which are absolute module ids), whether the checker printed relative or
 * absolute paths.
 */
export function parseTscErrors(output: string, root: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of output.split("\n")) {
    const match = ERROR_LINE.exec(line);
    if (!match) {
      continue;
    }
    const id = resolve(root, match[1].trim());
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Run the type-check command once and parse its diagnostics. A checker exits
 * nonzero precisely because it found errors, so a nonzero code with parseable
 * diagnostics is success. Only a run that produced no parseable diagnostics
 * AND failed (couldn't start, crashed, misconfigured) is an error — its
 * message is surfaced so the UI can show a type-check failure.
 */
export async function runTypeCheck(
  host: AnalysisHost,
  command: string[],
): Promise<{ counts: Map<string, number>; error?: string }> {
  const { stdout, stderr, code } = await host.exec(command[0], command.slice(1));
  // Diagnostics land on stdout, but honour stderr too for tools that split them.
  const counts = parseTscErrors(`${stdout}\n${stderr}`, host.root);
  if (counts.size === 0 && code !== 0) {
    const message = (stderr || stdout).trim();
    return {
      counts: new Map(),
      error: message || `type-check command exited with code ${code}`,
    };
  }
  return { counts };
}
