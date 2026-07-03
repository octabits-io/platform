import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "db/index": "src/db/index.ts",
    "factory/index": "src/factory/index.ts",
    "migrate/index": "src/migrate/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
});
