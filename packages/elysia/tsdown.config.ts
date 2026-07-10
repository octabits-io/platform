import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "index": "src/index.ts",
    "mcp": "src/mcp.ts",
  },
  format: "esm",
  // Emit .js/.d.ts (matching the exports map) instead of tsdown's default .mjs/.d.mts.
  fixedExtension: false,
  dts: true,
  clean: true,
});
