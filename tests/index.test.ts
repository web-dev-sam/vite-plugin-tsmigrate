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
  // Root the server in the playground: a real Vue app to analyse.
  const server = await createServer({
    root: fileURLToPath(new URL("../playground", import.meta.url)),
    configFile: false,
    customLogger: captureLogger(messages),
    // vue-tsc is not installed in the playground — keep the e2e deterministic
    // and fast by disabling the project type-check pass.
    plugins: [tsmigrate({ toolPort: 0, typeCheckCommand: false })],
    server: { port: 0 },
  });

  await server.listen();
  server.printUrls();

  const appUrl = server.resolvedUrls?.local[0];
  const match = messages.join("\n").match(/tsmigrate.*?(http:\/\/localhost:(\d+)\/)/);
  expect(match).not.toBeNull();
  const toolUrl = match![1];

  // The tool is unrelated to the user's app server — different port.
  expect(toolUrl).not.toBe(appUrl);

  // Diagnostics: environment summary.
  const diagRes = await fetch(new URL("/api/diagnostics", toolUrl));
  expect(diagRes.status).toBe(200);
  const diag = (await diagRes.json()) as Diagnostics;
  expect(diag.greeting).toBe("Hello, Vite 8!");
  expect(diag.vueVersion).toMatch(/^3\./);

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

  // App.vue is tracked in git — blame must resolve with real authors.
  expect(app.status.blame).toBe("ready");
  expect(Object.keys(app.blame?.authorLines ?? {}).length).toBeGreaterThan(0);
  // Counter may be untracked (error) but must not be stuck pending.
  expect(counter.status.blame).not.toBe("pending");

  // Cheap probe: unchanged version answers with a tiny payload.
  const probe = await (await fetch(new URL(`/api/graph?since=${graph.version}`, toolUrl))).json();
  expect(probe).toEqual({ version: graph.version, unchanged: true });

  // Lifecycle: closing the dev server also shuts the tool down.
  await server.close();
  await expect(fetch(toolUrl)).rejects.toThrow();
});
