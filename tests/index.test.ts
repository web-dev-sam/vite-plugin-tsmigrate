import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createLogger, createServer } from "vite";
import { expect, test } from "vite-plus/test";
import { type ComponentGraph, type Diagnostics, tsmigrate } from "../src/index.ts";
import { listenTool, stopToolServer } from "../src/server/index.ts";
import { createAnalysisHost } from "../src/server/vite-adapter.ts";
import { crawlGraph, findEntries } from "../src/analysis/graph.ts";

function captureLogger(messages: string[]) {
  const logger = createLogger("info", { allowClearScreen: false });
  logger.info = (msg) => {
    messages.push(msg);
  };
  return logger;
}

test("returns a plugin using the conventional vite-plugin-* name", () => {
  expect(tsmigrate().name).toBe("vite-plugin-tsmigrate");
});

// Regression: Laravel/Vue apps (and any app served via a framework template
// with `@vite('resources/js/app.ts')`) have NO root index.html — the entry is
// declared in `build.rollupOptions.input`. The adapter must surface it via
// `configuredEntries()` so the crawl produces a graph instead of 0 nodes.
// Exercises the real Vite resolver through the adapter, end to end.
test("crawls entries from build config when the app has no index.html", async () => {
  const root = fileURLToPath(new URL("./fixtures/laravel", import.meta.url));
  const entry = fileURLToPath(new URL("./fixtures/laravel/resources/js/app.ts", import.meta.url));
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    build: { rollupOptions: { input: entry } },
    plugins: [tsmigrate({ logOnStart: false, toolPort: 0 })],
  });

  try {
    const host = createAnalysisHost(server);
    expect(host.configuredEntries()).toContain(entry);

    const entries = await findEntries(host);
    expect(entries).toContain(entry);

    const { nodes, files } = await crawlGraph(host, entries);
    // The .vue tree reachable from the config entry is found (was empty before).
    expect(nodes.some((id) => id.endsWith("/App.vue"))).toBe(true);
    expect(nodes.some((id) => id.endsWith("/Child.vue"))).toBe(true);
    // import.meta.glob("./views/*.vue") expanded via the adapter's real glob.
    expect(nodes.some((id) => id.endsWith("/views/Dashboard.vue"))).toBe(true);
    expect(files.map((f) => f.id)).toContain(entry);
  } finally {
    await server.close();
  }
});

test("analyses the playground app and serves the component graph", async () => {
  const messages: string[] = [];
  // Root the server in a hermetic fixture app (a real small Vue app to
  // analyse). The playground is a large vben submodule — unfit for a fast,
  // deterministic e2e.
  const server = await createServer({
    root: fileURLToPath(new URL("./fixtures/app", import.meta.url)),
    configFile: false,
    customLogger: captureLogger(messages),
    // Keep the e2e deterministic and fast by disabling the project type-check
    // pass (the hermetic fixture has no vue-tsc toolchain of its own).
    plugins: [tsmigrate({ toolPort: 0, typeCheckCommand: false, blame: true })],
    server: { port: 0 },
  });

  await server.listen();
  server.printUrls();

  const appUrl = server.resolvedUrls?.local[0];
  // picocolors colourises the URL when CI is set (GitHub Actions), inserting
  // ANSI codes that split "localhost:<port>". Strip them so both the match and
  // the extracted URL are valid regardless of the runner's colour support.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const match = messages
    .join("\n")
    .replace(ansi, "")
    .match(/tsmigrate.*?(http:\/\/localhost:(\d+)\/)/);
  expect(match).not.toBeNull();
  const toolUrl = match![1];

  // The tool is unrelated to the user's app server — different port.
  expect(toolUrl).not.toBe(appUrl);

  // Diagnostics: environment summary.
  const diagRes = await fetch(new URL("/api/diagnostics", toolUrl));
  expect(diagRes.status).toBe(200);
  const diag = (await diagRes.json()) as Diagnostics;
  // Vue version is resolved from the app when present; the hermetic fixture
  // has no local vue install, so it may be null — accept either.
  expect(diag.vueVersion === null || typeof diag.vueVersion === "string").toBe(true);
  // Project name: no package.json in the fixture, so it falls back to the root dir basename.
  expect(diag.projectName).toBe("app");

  // Component graph: poll until queued analyzers (blame) finish.
  const graphUrl = new URL("/api/graph", toolUrl);
  await expect
    .poll(async () => ((await (await fetch(graphUrl)).json()) as ComponentGraph).complete, {
      timeout: 5000,
    })
    .toBe(true);
  const graph = (await (await fetch(graphUrl)).json()) as ComponentGraph;

  const files = graph.vue.nodes.map((node) => node.file);
  expect(files).toContain("src/App.vue");
  expect(files).toContain("src/components/Counter.vue");

  const app = graph.vue.nodes.find((node) => node.file === "src/App.vue")!;
  const counter = graph.vue.nodes.find((node) => node.file === "src/components/Counter.vue")!;
  expect(app.loc).toBeGreaterThan(5);
  expect(app.kind).toBe("vue");
  // App imports Counter directly — a barrel-collapsed vue edge.
  expect(graph.vue.edges).toContainEqual({ from: app.id, to: counter.id });

  // Type-check is disabled here: every node reads as typed, nothing red.
  expect(app.status.typecheck).toBe("ready");
  expect(app.typeErrors).toBeNull();
  expect(app.strictRed).toBe(false);

  // The full graph also walks `.ts` modules (e.g. the entry) with raw edges.
  const fullFiles = graph.full.nodes.map((node) => node.file);
  expect(fullFiles).toContain("src/main.ts");
  expect(graph.full.nodes.length).toBeGreaterThanOrEqual(graph.vue.nodes.length);

  // Blame runs a real `git blame`; the fixture files are untracked, so the
  // queued analyzer must resolve (ready or error) and never stay pending.
  // Blame parsing itself is covered deterministically in analysis.test.ts.
  expect(app.status.blame).not.toBe("pending");
  // Counter may be untracked (error) but must not be stuck pending.
  expect(counter.status.blame).not.toBe("pending");

  // Cheap probe: unchanged version answers with a tiny payload.
  const probe = await (await fetch(new URL(`/api/graph?since=${graph.version}`, toolUrl))).json();
  expect(probe).toEqual({ version: graph.version, unchanged: true });

  // Lifecycle: the tool server is process-scoped (it survives dev-server
  // restarts so the tool-UI proxy never loses its port), so closing the dev
  // server leaves it bound; `stopToolServer` is the explicit teardown.
  await server.close();
  stopToolServer();
  await expect(fetch(toolUrl)).rejects.toThrow();
});

test("listenTool reclaims its preferred port once it frees, not an ephemeral one", async () => {
  // A blocker holds the preferred port, standing in for the previous dev-server
  // instance still releasing it while a restart is in flight.
  const blocker = createHttpServer();
  const preferred = await new Promise<number>((resolve) => {
    blocker.listen(0, "127.0.0.1", () => {
      const addr = blocker.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  const tool = createHttpServer();
  const bound = listenTool(tool, preferred);
  // Wait for the first bind to fail (port busy) so the retry path is exercised,
  // then release the port — the plugin must reclaim the SAME port, where the
  // old behaviour drifted straight to a random ephemeral one (orphaning the
  // tool-UI HMR proxy that targets it).
  await once(tool, "error");
  await new Promise<void>((resolve) => blocker.close(() => resolve()));

  try {
    expect(await bound).toBe(preferred);
  } finally {
    await new Promise<void>((resolve) => tool.close(() => resolve()));
  }
});
