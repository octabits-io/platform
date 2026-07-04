import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "index": "src/index.ts",
    "altcha": "src/altcha.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
});
