import { createLogger, createServer } from "vite";
import { expect, test } from "vite-plus/test";
import { tsmigrate, VIRTUAL_MODULE_ID } from "../src/index.ts";

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
  const logger = createLogger("info", { allowClearScreen: false });
  logger.info = (msg) => {
    messages.push(msg);
  };

  const server = await createServer({
    configFile: false,
    customLogger: logger,
    plugins: [tsmigrate()],
    server: { port: 0 },
  });

  await server.listen();
  try {
    server.printUrls();
    expect(messages.join("\n")).toMatch(
      /\[vite-plugin-tsmigrate\] serving http:\/\/localhost:\d+\//,
    );
  } finally {
    await server.close();
  }
});
