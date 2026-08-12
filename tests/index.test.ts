import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, createServer, preview } from "vite";
import { expect, test } from "vite-plus/test";
import { tsmigrate, VIRTUAL_MODULE_ID } from "../src/index.ts";

function captureLogger(messages: string[]) {
  const logger = createLogger("info", { allowClearScreen: false });
  logger.info = (msg) => {
    messages.push(msg);
  };
  return logger;
}

// Log lines may carry ANSI color codes depending on the environment, so match
// loosely around the label and URL.
const SERVING_LINE = /tsmigrate.*http:\/\/localhost.*\d+/;

test("returns a plugin using the conventional vite-plugin-* name", () => {
  expect(tsmigrate().name).toBe("vite-plugin-tsmigrate");
});

test("serves the greeting through the virtual module in a real Vite server", async () => {
  const server = await createServer({
    configFile: false,
    logLevel: "silent",
    plugins: [tsmigrate({ greeting: "Hi from tests", logOnStart: false })],
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
    plugins: [tsmigrate()],
  });

  try {
    const result = await server.transformRequest(VIRTUAL_MODULE_ID);
    expect(result?.code).toContain("Hello, Vite 8!");
  } finally {
    await server.close();
  }
});

test("logs the dev server URL through printUrls once listening", async () => {
  const messages: string[] = [];
  const server = await createServer({
    configFile: false,
    customLogger: captureLogger(messages),
    plugins: [tsmigrate()],
    server: { port: 0 },
  });

  await server.listen();
  try {
    server.printUrls();
    expect(messages.join("\n")).toMatch(SERVING_LINE);
  } finally {
    await server.close();
  }
});

test("logs the preview server URL in production preview", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "tsmigrate-preview-"));
  await writeFile(join(outDir, "index.html"), "<!doctype html>ok\n");

  const messages: string[] = [];
  const server = await preview({
    configFile: false,
    customLogger: captureLogger(messages),
    plugins: [tsmigrate()],
    build: { outDir },
    preview: { port: 0 },
  });

  try {
    server.printUrls();
    expect(messages.join("\n")).toMatch(SERVING_LINE);
  } finally {
    await server.close();
  }
});
