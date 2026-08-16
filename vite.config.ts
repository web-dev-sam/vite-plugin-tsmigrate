import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // Two entries: the plugin, and the `tsmigrate` bin (src/bin.ts).
    entry: ["src/index.ts", "src/bin.ts"],
    dts: {
      tsgo: true,
    },
  },
  lint: {
    ignorePatterns: [
      "playground/vben",
      "playground-vuetify/vuetify",
      "playground-shadcn",
      "tests/fixtures",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: [
      "playground/vben",
      "playground-vuetify/vuetify",
      "playground-shadcn",
      "tests/fixtures",
    ],
  },
  // Only our suite — never vben's or the fixtures' spec files under the tree.
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
