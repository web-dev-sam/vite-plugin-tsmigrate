import { relative } from "node:path";
import type { BlameSummary } from "../../shared/types.ts";
import type { Analyzer, AnalyzerContext } from "./index.ts";

/**
 * Lines per author from `git blame --line-porcelain` (one `author <name>`
 * header per source line). Uncommitted lines show up as "Not Committed Yet";
 * untracked files reject and surface as an error status on the node.
 */
export function parseBlamePorcelain(porcelain: string): BlameSummary {
  const authorLines: Record<string, number> = {};
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("author ")) {
      const author = line.slice("author ".length);
      authorLines[author] = (authorLines[author] ?? 0) + 1;
    }
  }
  return { authorLines };
}

/**
 * Collapse raw `git blame` author names onto canonical display names via a
 * user-supplied map, merging line counts (e.g. an old handle and a full name
 * that are the same person). Unmapped authors pass through; an empty map is a
 * no-op that returns the input unchanged.
 */
export function applyBlameAliases(
  summary: BlameSummary,
  aliases: Record<string, string>,
): BlameSummary {
  if (Object.keys(aliases).length === 0) {
    return summary;
  }
  const authorLines: Record<string, number> = {};
  for (const [author, lines] of Object.entries(summary.authorLines)) {
    const name = aliases[author] ?? author;
    authorLines[name] = (authorLines[name] ?? 0) + lines;
  }
  return { authorLines };
}

/** Spawn-bound — always scheduled on the bounded background queue. */
export const blameAnalyzer: Analyzer<BlameSummary> = {
  name: "blame",
  cost: "queued",
  async analyze({ host, file }: AnalyzerContext): Promise<BlameSummary> {
    const output = await host.runGit([
      "blame",
      "--line-porcelain",
      "--",
      relative(host.root, file),
    ]);
    return parseBlamePorcelain(output);
  },
};
