import { createLogger, createServer } from "vite";
import { expect, test } from "vite-plus/test";
import { tsmigrate, VIRTUAL_MODULE_ID } from "../src/index.ts";

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

test("hosts its own tool on a separate port and closes it with the dev server", async () => {
  const messages: string[] = [];
  const server = await createServer({
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

  // The tool actually serves its page.
  const res = await fetch(toolUrl);
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("vite-plugin-tsmigrate");
  expect(body).toContain("Hello, Vite 8!");

  // Lifecycle: closing the dev server also shuts the tool down.
  await server.close();
  await expect(fetch(toolUrl)).rejects.toThrow();
});
