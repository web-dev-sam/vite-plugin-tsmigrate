import { resolve } from "node:path";
import pc from "picocolors";
import { createServer, type ViteDevServer } from "vite";
import { crawlGraph, findEntries } from "./analysis/graph.ts";
import type { AnalysisHost } from "./analysis/host.ts";
import { findCycles, type FileFacts, makeGraph } from "./analysis/topology.ts";
import { createAnalysisHost } from "./server/vite-adapter.ts";

/**
 * `tsmigrate` — the plugin's CLI half.
 *
 * A type is a contract, and a parent extends the contract of everything it
 * imports: typing a parent before its children means guessing the child's
 * contract, then writing it again. So the only cheap order is bottom-up, and
 * `depth` is that order — depth 0 imports nothing else in the project, depth 1
 * imports only depth 0, and so on. The same concentric rings the tool UI draws
 * (`ComponentNode.height`), emitted as a work list.
 *
 * Deliberately NOT the analysis engine: depth is pure topology over the crawl,
 * so this path runs no type-check pass, no git, no maintainability score. One
 * Vite config load — for the project's real resolver (aliases,
 * `import.meta.glob`, SFC scripts) — and one crawl.
 *
 * stdout is a data channel: paths only, one per line, sorted. Summaries,
 * warnings, and anything the user's own config prints go to stderr.
 */

const USAGE = `Usage: tsmigrate depth [n] [options]

Lists project files child-first: depth 0 imports nothing else in the project,
so its types are the contracts every parent extends. Type depth 0, then 1, ...

Arguments:
  n                  only the files at this depth (default: every depth,
                     printed as "<depth>\\t<file>")

Options:
  -u, --untyped      only files that still need typing (.js family, or an SFC
                     whose <script> is not lang="ts")
  -g, --graph <g>    "full" (every module) or "vue" (components only, barrel
                     hops collapsed) [default: full]
  -j, --json         emit layers and cycles as JSON
  -r, --root <dir>   project root [default: cwd]
  -c, --config <f>   vite config file [default: auto-detected]
  -h, --help         print this

Examples:
  tsmigrate depth 0                     # start here
  tsmigrate depth --untyped             # the whole migration, in order
  tsmigrate depth 0 -u | sed 's/^/- [ ] /'`;

/** Cycles are a warning, not the payload — the full list lives in `--json`. */
const MAX_CYCLES_SHOWN = 5;
const MAX_CYCLE_MEMBERS_SHOWN = 6;

export interface CliIo {
  /** One line of payload on stdout. */
  out(line: string): void;
  /** One line of diagnostics on stderr. */
  err(line: string): void;
}

interface Command {
  /** Single depth to print, or null for every depth. */
  depth: number | null;
  graph: "vue" | "full";
  untyped: boolean;
  json: boolean;
  root: string;
  config: string | undefined;
}

/** Payload, diagnostics and exit code — kept separate so stdout stays clean. */
interface Report {
  lines: string[];
  warnings: string[];
  code: number;
}

function parseArgv(argv: string[]): Command | { error: string } {
  const command: Command = {
    depth: null,
    graph: "full",
    untyped: false,
    json: false,
    root: process.cwd(),
    config: undefined,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    // Value flags accept `--flag=value` or the next entry; boolean flags read
    // neither, so they never swallow the argument behind them.
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (flag) {
      case "-u":
      case "--untyped":
        command.untyped = true;
        break;
      case "-j":
      case "--json":
        command.json = true;
        break;
      case "-g":
      case "--graph": {
        const value = inline ?? argv[++i];
        if (value !== "vue" && value !== "full") {
          return { error: `${flag} expects "vue" or "full", got ${value ?? "nothing"}` };
        }
        command.graph = value;
        break;
      }
      case "-r":
      case "--root": {
        const value = inline ?? argv[++i];
        if (value === undefined) {
          return { error: `${flag} expects a directory` };
        }
        command.root = resolve(value);
        break;
      }
      case "-c":
      case "--config": {
        const value = inline ?? argv[++i];
        if (value === undefined) {
          return { error: `${flag} expects a file` };
        }
        command.config = resolve(value);
        break;
      }
      default:
        return { error: `unknown option "${flag}"` };
    }
  }

  if (positional.length === 0) {
    return { error: "no command given" };
  }
  if (positional[0] !== "depth") {
    return { error: `unknown command "${positional[0]}"` };
  }
  if (positional.length > 2) {
    return { error: `unexpected argument "${positional[2]}"` };
  }
  const n = positional[1];
  if (n !== undefined) {
    if (!/^\d+$/.test(n)) {
      return { error: `depth expects a non-negative integer, got "${n}"` };
    }
    command.depth = Number(n);
  }
  return command;
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    io.out(USAGE);
    return 0;
  }
  const command = parseArgv(argv);
  if ("error" in command) {
    io.err(`tsmigrate: ${command.error}`);
    io.err(USAGE);
    return 2;
  }

  // The user's config and plugins may print on stdout, which here is the
  // payload channel — divert it to stderr for as long as their code can run.
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

  let server: ViteDevServer | undefined;
  let report: Report;
  try {
    // Middleware mode on purpose: no http server, so nothing binds a port —
    // including this plugin's own tool server when it is in the user's config.
    server = await createServer({
      root: command.root,
      configFile: command.config,
      logLevel: "silent",
      server: { middlewareMode: true },
    });
    report = await collect(command, createAnalysisHost(server));
  } catch (error) {
    report = {
      lines: [],
      warnings: [`tsmigrate: ${error instanceof Error ? error.message : String(error)}`],
      code: 1,
    };
  } finally {
    await server?.close();
    process.stdout.write = stdoutWrite;
  }

  for (const line of report.lines) {
    io.out(line);
  }
  for (const warning of report.warnings) {
    io.err(warning);
  }
  return report.code;
}

/** Crawl, layer by depth, render. The whole command minus process wiring. */
async function collect(command: Command, host: AnalysisHost): Promise<Report> {
  const entries = await findEntries(host);
  if (entries.length === 0) {
    return {
      lines: [],
      warnings: [
        `tsmigrate: no entry module under ${host.root} — expected a root index.html with a <script type="module">, or build.rollupOptions.input. Point --root/--config at the app.`,
      ],
      code: 1,
    };
  }
  const crawl = await crawlGraph(host, entries);

  // `makeGraph` wants a fact bundle per node; only topology is read here, so
  // every analyzer reports as unrun rather than as a fake zero.
  const facts = new Map<string, FileFacts>();
  for (const file of crawl.files) {
    facts.set(file.id, {
      kind: file.kind,
      loc: null,
      cc: null,
      blame: null,
      typeErrors: null,
      status: { loc: "pending", cc: "pending", blame: "pending", typecheck: "pending" },
      errors: {},
    });
  }
  const vueGraph = command.graph === "vue";
  const graph = makeGraph(
    new Set(vueGraph ? crawl.nodes : crawl.files.map((file) => file.id)),
    vueGraph ? crawl.componentEdges : crawl.moduleEdges,
    facts,
    host.root,
  );

  const children = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    children.set(node.id, new Set());
  }
  for (const edge of graph.edges) {
    children.get(edge.from)!.add(edge.to);
  }
  const cycles = findCycles(
    graph.nodes.map((node) => node.id),
    children,
  );

  const typedOf = new Map(crawl.files.map((file) => [file.id, file.typed]));
  const fileOf = new Map(graph.nodes.map((node) => [node.id, node.file]));
  const layers = new Map<number, string[]>();
  let selected = 0;
  for (const node of graph.nodes) {
    if (command.untyped && (typedOf.get(node.id) ?? true)) {
      continue;
    }
    const layer = layers.get(node.height);
    if (layer) {
      layer.push(node.file);
    } else {
      layers.set(node.height, [node.file]);
    }
    selected++;
  }
  for (const layer of layers.values()) {
    layer.sort();
  }
  const depths = [...layers.keys()]
    .sort((a, b) => a - b)
    .filter((depth) => command.depth === null || depth === command.depth);

  const scope = command.untyped
    ? `${selected} untyped of ${graph.nodes.length} files`
    : `${graph.nodes.length} files`;
  const warnings = [
    pc.dim(
      `tsmigrate: ${scope}, depth 0-${graph.maxHeight}, ${command.graph} graph, root ${host.root}`,
    ),
  ];
  if (cycles.length > 0) {
    const members = cycles.reduce((total, cycle) => total + cycle.length, 0);
    warnings.push(
      pc.yellow(
        `tsmigrate: ${cycles.length} import cycle(s) over ${members} files — no child-first order exists inside a cycle, so their depth is arbitrary; type each cycle's files together, or cut an edge first:`,
      ),
    );
    for (const cycle of cycles.slice(0, MAX_CYCLES_SHOWN)) {
      const shown = cycle
        .slice(0, MAX_CYCLE_MEMBERS_SHOWN)
        .map((id) => fileOf.get(id) ?? id)
        .join(" + ");
      const rest = cycle.length - MAX_CYCLE_MEMBERS_SHOWN;
      warnings.push(pc.yellow(`  ${shown}${rest > 0 ? ` + ${rest} more` : ""}`));
    }
    if (cycles.length > MAX_CYCLES_SHOWN) {
      warnings.push(pc.yellow(`  ... ${cycles.length - MAX_CYCLES_SHOWN} more cycles (--json)`));
    }
  }

  if (command.json) {
    return {
      lines: JSON.stringify(
        {
          root: host.root,
          graph: command.graph,
          maxDepth: graph.maxHeight,
          files: selected,
          layers: depths.map((depth) => ({ depth, files: layers.get(depth)! })),
          cycles: cycles.map((cycle) => cycle.map((id) => fileOf.get(id) ?? id)),
        },
        null,
        2,
      ).split("\n"),
      warnings,
      code: 0,
    };
  }
  const lines: string[] = [];
  for (const depth of depths) {
    for (const file of layers.get(depth)!) {
      lines.push(command.depth === null ? `${depth}\t${file}` : file);
    }
  }
  return { lines, warnings, code: 0 };
}
