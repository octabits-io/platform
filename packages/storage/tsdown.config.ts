import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "index": "src/index.ts",
    "s3": "src/s3.ts",
    "postgres": "src/postgres.ts",
  },
  format: "esm",
  // Emit .js/.d.ts (matching the exports map) instead of tsdown's default .mjs/.d.mts.
  fixedExtension: false,
  dts: true,
  clean: true,
});
