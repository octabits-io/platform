import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "index": "src/index.ts",
    "s3": "src/s3.ts",
    "postgres": "src/postgres.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
});
