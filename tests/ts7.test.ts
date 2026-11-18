import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { createTs7Checker } from "../src/server/ts7.ts";

// A hermetic Vue project checked by the real TypeScript 7.1 API + content
// mapper — the plugin's own dependencies, linked into the project through the
// shim config, while the repo's own `typescript` stays 7.0.
const root = fileURLToPath(new URL("./fixtures/ts7", import.meta.url));
const file = (rel: string) => `${root}/${rel}`;

test(
  "TS 7.1 checker reports per-file errors and follows watcher events",
  { timeout: 60_000 },
  async () => {
    const checker = createTs7Checker(root, "tsconfig.ts7-check.json");
    const added = file("src/added.ts");
    try {
      const first = await checker.check();
      expect(first.error).toBeUndefined();
      // Only App.vue's `<script setup>` error — mapped back to the SFC position.
      expect([...first.errors.keys()]).toEqual([file("src/App.vue")]);
      expect(first.errors.get(file("src/App.vue"))).toEqual([
        {
          line: 2,
          column: 7,
          code: 2322,
          message: "Type 'number' is not assignable to type 'string'.",
        },
      ]);

      writeFileSync(added, "export const added: number = 'nope';\n");
      checker.fileChanged(added, "add");
      const second = await checker.check();
      expect(second.errors.get(added)?.map((error) => error.code)).toEqual([2322]);

      rmSync(added);
      checker.fileChanged(added, "unlink");
      const third = await checker.check();
      expect(third.errors.has(added)).toBe(false);
      expect(third.errors.has(file("src/App.vue"))).toBe(true);
    } finally {
      rmSync(added, { force: true });
      checker.dispose();
    }
  },
);

test(
  "TS 7.1 checker generates its config when the project has none",
  { timeout: 60_000 },
  async () => {
    // No `missing.json`: the shim extends the fixture's plain `tsconfig.json`
    // (no `include`) and adds the Vue mapper itself.
    const checker = createTs7Checker(root, "missing.json");
    try {
      const result = await checker.check();
      expect(result.error).toBeUndefined();
      expect([...result.errors.keys()]).toEqual([file("src/App.vue")]);
    } finally {
      checker.dispose();
    }
  },
);
