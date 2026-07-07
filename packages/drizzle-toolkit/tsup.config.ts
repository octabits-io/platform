import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "db/index": "src/db/index.ts",
    "factory/index": "src/factory/index.ts",
    "migrate/index": "src/migrate/index.ts",
    "scope/index": "src/scope/index.ts",
    "idempotency/index": "src/idempotency/index.ts",
    "crud/index": "src/crud/index.ts",
    "scoped-key-store/index": "src/scoped-key-store/index.ts",
    "config/index": "src/config/index.ts",
    "rls/index": "src/rls/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
});
