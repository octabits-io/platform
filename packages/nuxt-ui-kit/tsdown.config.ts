import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "auth/index": "src/auth/index.ts",
    "api/index": "src/api/index.ts",
    "i18n/index": "src/i18n/index.ts",
    "locale/index": "src/locale/index.ts",
    "zod/index": "src/zod/index.ts",
    "dates/index": "src/dates/index.ts",
    "ai/index": "src/ai/index.ts",
  },
  format: "esm",
  // Emit .js/.d.ts (matching the exports map) instead of tsdown's default .mjs/.d.mts.
  fixedExtension: false,
  dts: true,
  clean: true,
});
