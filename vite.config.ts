import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
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
