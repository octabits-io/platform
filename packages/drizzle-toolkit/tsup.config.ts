import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "db/index": "src/db/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
});
