import { fileURLToPath } from "node:url";
import { createLogger, createServer } from "vite";
import { expect, test } from "vite-plus/test";
import {
  type ComponentGraph,
  type Diagnostics,
  tsmigrate,
  VIRTUAL_MODULE_ID,
} from "../src/index.ts";

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

test("serves the greeting through the virtual module in a real Vite server", async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "silent",
    plugins: [tsmigrate({ greeting: "Hi from tests", logOnStart: false, toolPort: 0 })],
  });

  try {
    const result = await server.transformRequest(VIRTUAL_MODULE_ID);
    expect(result?.code).toContain("Hi from tests");
  } finally {
    await server.close();
  }
});

test("falls back to the default greeting when no options are given", async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "silent",
    plugins: [tsmigrate({ logOnStart: false, toolPort: 0 })],
  });

  try {
    const result = await server.transformRequest(VIRTUAL_MODULE_ID);
    expect(result?.code).toContain("Hello, Vite 8!");
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
  const match = messages.join("\n").replace(ansi, "").match(/tsmigrate.*?(http:\/\/localhost:(\d+)\/)/);
  expect(match).not.toBeNull();
  const toolUrl = match![1];

  // The tool is unrelated to the user's app server — different port.
  expect(toolUrl).not.toBe(appUrl);

  // Diagnostics: environment summary.
  const diagRes = await fetch(new URL("/api/diagnostics", toolUrl));
  expect(diagRes.status).toBe(200);
  const diag = (await diagRes.json()) as Diagnostics;
  expect(diag.greeting).toBe("Hello, Vite 8!");
  // Vue version is resolved from the app when present; the hermetic fixture
  // has no local vue install, so it may be null — accept either.
  expect(diag.vueVersion === null || typeof diag.vueVersion === "string").toBe(true);

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

  // Lifecycle: closing the dev server also shuts the tool down.
  await server.close();
  await expect(fetch(toolUrl)).rejects.toThrow();
});
