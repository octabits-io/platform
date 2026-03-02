import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "result/index": "src/result/index.ts",
    "ioc/index": "src/ioc/index.ts",
    "logger/index": "src/logger/index.ts",
    "utils/index": "src/utils/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
});
