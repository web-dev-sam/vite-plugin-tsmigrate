import { fileURLToPath } from "node:url";
import { createLogger, createServer } from "vite";
import { expect, test } from "vite-plus/test";
import { type Diagnostics, tsmigrate, VIRTUAL_MODULE_ID } from "../src/index.ts";

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

test("hosts its tool app on a separate port with a diagnostics API", async () => {
  const messages: string[] = [];
  // Root the server in the playground: a real Vue app for the diagnostics
  // API to detect.
  const server = await createServer({
    root: fileURLToPath(new URL("../playground", import.meta.url)),
    configFile: false,
    customLogger: captureLogger(messages),
    plugins: [tsmigrate({ toolPort: 0 })],
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

  // The tool page answers (prebuilt Vue UI when dist/client exists, an
  // explanatory fallback otherwise).
  const page = await fetch(toolUrl);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");

  // The diagnostics API inspects the user's app.
  const res = await fetch(new URL("/api/diagnostics", toolUrl));
  expect(res.status).toBe(200);
  const diag = (await res.json()) as Diagnostics;
  expect(diag.greeting).toBe("Hello, Vite 8!");
  expect(diag.appUrl).toBe(appUrl);
  expect(diag.plugins).toContain("vite-plugin-tsmigrate");
  expect(Array.isArray(diag.vueModules)).toBe(true);
  expect(diag.vueVersion).toMatch(/^3\./);

  // Lifecycle: closing the dev server also shuts the tool down.
  await server.close();
  await expect(fetch(toolUrl)).rejects.toThrow();
});
