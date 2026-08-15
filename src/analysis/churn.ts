import { dirname, relative, resolve, sep } from "node:path";

/**
 * Real-churn volatility estimation from git history — the empirical half of
 * the maintainability score's volatility term (the structural half is Martin
 * instability, see `maintainability.ts`).
 *
 * One `git log --numstat -M` pass per repository yields, per current file, a
 * damped **deleted-lines-per-month** rate over a fixed 18-month window:
 *
 * - **Deleted lines only**: appending to a registry/barrel/config is
 *   risk-free — modifying existing lines is risk. An icon barrel that grows
 *   +60/−2 reads calm; a hub that rewrites its lines reads hot. (Validated
 *   against production: added-lines counting marked vben's `lucide.ts` fully
 *   volatile.)
 * - **Rename chaining** (`-M`): history is walked newest → oldest, re-pointing
 *   each `old => new` record so churn before a rename still lands on the
 *   file's present-day path.
 * - **Bulk-commit damping**: a commit touching k files carries weight
 *   `min(1, √(BULK_DAMP_FILES / k))`; commits above `BULK_DROP_FILES` files
 *   (formatting passes, codemods) are dropped from churn entirely (their
 *   rename records still chain).
 * - **Fixed window**: the rate divides by `WINDOW_MONTHS`, never by file or
 *   repo age. (An age denominator saturated shallow-clone fixtures and is
 *   deliberately absent; deepen fixtures instead — see
 *   `docs/maintainability-score.md`.) Exponential recency decay is likewise
 *   OFF until re-validated against the regression fixtures.
 *
 * The scorer turns the rate into a volatility via an **absolute** saturating
 * scale with a structural floor — deliberately not a per-repo percentile,
 * which would make every repo's hottest file read vol ≈ 1 and destroy
 * cross-repo comparability.
 *
 * Multi-repo aware: each file is attributed to its nearest enclosing git
 * work tree (`git -C <dir> rev-parse --show-toplevel`, walk-up cached), so
 * apps whose Vite root sits in a parent repo with submodules (or in no repo
 * at all) still get history for the files that have one. Files without a
 * repo or without commits simply yield no entry — the scorer falls back to
 * the structural floor.
 */

/** The estimator's fixed observation window, in months (~18 months fetched as days). */
export const WINDOW_MONTHS = 18;
/** Only fetch history this recent — the fixed window in days. */
export const HISTORY_WINDOW_DAYS = WINDOW_MONTHS * 30;
/** Commits touching more files than this are damped by √(BULK_DAMP_FILES/k). */
export const BULK_DAMP_FILES = 30;
/** Commits touching more files than this are dropped (formatting/codemods). */
export const BULK_DROP_FILES = 200;

/** Damped churn aggregates for one current file. */
export interface FileChurn {
  /**
   * Effective observation count: Σ damp over commits touching the file.
   * `> 0` means usable history exists — drives the churn-coverage readout.
   */
  nEff: number;
  /**
   * Damped deleted lines per month over the fixed window — the existing-line
   * change rate before size normalisation. The scorer divides by the file's
   * LoC and saturates.
   */
  deletedPerMonth: number;
}

/** One parsed commit: unix seconds + its numstat rows (renames pre-split). */
export interface ChurnCommit {
  time: number;
  files: Array<{
    /** Present-day-at-this-commit path (the rename target for renames). */
    path: string;
    /** Deleted lines only — appended lines carry no change risk; 0 for binary rows. */
    deleted: number;
    /** Set when this row is a rename record (`old => new`). */
    renamedFrom: string | null;
  }>;
}

/** Collapse the `//` and leading `/` artifacts of empty rename-brace sides. */
const fixPath = (p: string): string => p.replace(/\/{2,}/g, "/").replace(/^\//, "");

/**
 * Split a numstat rename path — `dir/{old => new}.ts`, `{ => src}/a.ts`, or
 * the braceless `old.ts => new.ts` — into old and new. Null for plain paths.
 */
function splitRename(raw: string): { from: string; to: string } | null {
  const brace = raw.indexOf("{");
  if (brace !== -1) {
    const arrow = raw.indexOf(" => ", brace);
    const close = raw.indexOf("}", brace);
    if (arrow !== -1 && close !== -1 && arrow < close) {
      const pre = raw.slice(0, brace);
      const post = raw.slice(close + 1);
      return {
        from: fixPath(pre + raw.slice(brace + 1, arrow) + post),
        to: fixPath(pre + raw.slice(arrow + 4, close) + post),
      };
    }
  }
  const arrow = raw.indexOf(" => ");
  if (arrow !== -1) {
    return { from: raw.slice(0, arrow), to: raw.slice(arrow + 4) };
  }
  return null;
}

/**
 * Parse `git log --numstat -M --pretty=format:%x01%ct` output. Commit marker
 * lines start with `\x01`; numstat rows are `added\tdeleted\tpath` (`-` for
 * binary). Unrecognised lines are skipped, so partial/odd output degrades to
 * fewer commits, never a throw.
 */
export function parseNumstatLog(log: string): ChurnCommit[] {
  const commits: ChurnCommit[] = [];
  let current: ChurnCommit | null = null;
  for (const line of log.split("\n")) {
    if (line.startsWith("\x01")) {
      const time = Number(line.slice(1).trim());
      current = Number.isFinite(time) ? { time, files: [] } : null;
      if (current) {
        commits.push(current);
      }
      continue;
    }
    if (!current || line === "") {
      continue;
    }
    const first = line.indexOf("\t");
    const second = first === -1 ? -1 : line.indexOf("\t", first + 1);
    if (second === -1) {
      continue;
    }
    const deleted = line.slice(first + 1, second);
    const raw = line.slice(second + 1);
    if (raw === "") {
      continue;
    }
    const del = deleted === "-" ? 0 : Number(deleted) || 0;
    const rename = splitRename(raw);
    current.files.push({
      path: rename ? rename.to : raw,
      deleted: del,
      renamedFrom: rename ? rename.from : null,
    });
  }
  return commits;
}

/**
 * Aggregate parsed commits into per-file churn for the files in `loc`
 * (repo-relative path → maintainable LoC; values gate membership only).
 * Walks newest → oldest chaining renames, so all history lands on
 * present-day paths; only present-day files appear in the result.
 */
export function estimateChurn(
  commits: ChurnCommit[],
  loc: ReadonlyMap<string, number>,
): Map<string, FileChurn> {
  const ordered = [...commits].sort((a, b) => b.time - a.time);
  // Historical name → present-day name, built up while walking backward.
  const alias = new Map<string, string>();
  const acc = new Map<string, { nEff: number; deleted: number }>();

  for (const commit of ordered) {
    const k = commit.files.length;
    // Codemod-scale commits carry no churn signal but their renames still chain.
    const weight = k > BULK_DROP_FILES ? 0 : Math.min(1, Math.sqrt(BULK_DAMP_FILES / k));
    for (const row of commit.files) {
      const canon = alias.get(row.path) ?? row.path;
      if (row.renamedFrom !== null) {
        // Older commits know this file by its pre-rename name.
        alias.set(row.renamedFrom, canon);
      }
      if (!loc.has(canon) || weight === 0) {
        continue; // untracked file, or a dropped codemod (renames still chain)
      }
      const entry = acc.get(canon) ?? { nEff: 0, deleted: 0 };
      entry.nEff += weight;
      entry.deleted += weight * row.deleted;
      acc.set(canon, entry);
    }
  }

  const churn = new Map<string, FileChurn>();
  for (const [path, entry] of acc) {
    churn.set(path, { nEff: entry.nEff, deletedPerMonth: entry.deleted / WINDOW_MONTHS });
  }
  return churn;
}

/** The one capability churn collection needs — `AnalysisHost.runGit` satisfies it. */
export interface ChurnHost {
  /** Run git with the given argv, resolving with stdout. Rejects on failure. */
  runGit(args: string[]): Promise<string>;
}

/**
 * Nearest enclosing git work-tree top per file, submodule-aware: a submodule
 * is one gitlink entry in its parent, so `git log` at the parent root returns
 * nothing for files inside it — each file must be attributed to ITS repo.
 * One `rev-parse --show-toplevel` per unresolved directory, with walk-up
 * caching (every dir between a query and its answer shares the answer; git
 * itself walked exactly that chain). Null = not in any work tree.
 */
export async function resolveGitTops(
  host: ChurnHost,
  files: Iterable<string>,
): Promise<Map<string, string | null>> {
  const dirCache = new Map<string, string | null>();
  const tops = new Map<string, string | null>();
  for (const file of files) {
    const dir = dirname(file);
    let top = dirCache.get(dir);
    if (top === undefined) {
      try {
        top = resolve((await host.runGit(["-C", dir, "rev-parse", "--show-toplevel"])).trim());
      } catch {
        top = null;
      }
      // Fill the chain the rev-parse walked: dir up to (and including) top.
      // A repo strictly between them would have answered instead, so every
      // dir on the chain shares this top. A null answer proves nothing about
      // ancestors' descendants, so cache only the queried dir.
      let d = dir;
      for (;;) {
        dirCache.set(d, top);
        const parent = dirname(d);
        if (top === null || d === top || parent === d) {
          break;
        }
        d = parent;
      }
    }
    tops.set(file, top);
  }
  return tops;
}

/**
 * Collect per-file churn for `files` (absolute id → maintainable LoC): group
 * by enclosing repo, run one bounded `git log --numstat -M` per repo, chain
 * renames, and return absolute-id-keyed churn. Files without a repo, without
 * history, or in a repo whose log fails simply have no entry — the scorer's
 * structural floor applies to them. Never rejects.
 */
export async function collectChurn(
  host: ChurnHost,
  files: ReadonlyMap<string, number>,
): Promise<Map<string, FileChurn>> {
  const tops = await resolveGitTops(host, files.keys());
  // repo top → (repo-relative path → [absolute id, loc])
  const byRepo = new Map<string, Map<string, string>>();
  const relLoc = new Map<string, Map<string, number>>();
  for (const [file, loc] of files) {
    const top = tops.get(file);
    if (top == null) {
      continue;
    }
    const rel = relative(top, file).split(sep).join("/");
    let repoFiles = byRepo.get(top);
    if (!repoFiles) {
      repoFiles = new Map();
      byRepo.set(top, repoFiles);
      relLoc.set(top, new Map());
    }
    repoFiles.set(rel, file);
    relLoc.get(top)!.set(rel, loc);
  }

  const churn = new Map<string, FileChurn>();
  for (const [top, repoFiles] of byRepo) {
    let log: string;
    try {
      log = await host.runGit([
        "-C",
        top,
        "-c",
        "core.quotepath=off",
        "log",
        "-M",
        "--numstat",
        "--no-color",
        `--since=${HISTORY_WINDOW_DAYS}.days`,
        "--pretty=format:%x01%ct",
      ]);
    } catch {
      continue; // no history (empty repo) or unreadable — structural prior applies
    }
    const perFile = estimateChurn(parseNumstatLog(log), relLoc.get(top)!);
    for (const [rel, stats] of perFile) {
      const abs = repoFiles.get(rel);
      if (abs !== undefined) {
        churn.set(abs, stats);
      }
    }
  }
  return churn;
}
