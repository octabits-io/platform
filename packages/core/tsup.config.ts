import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "index": "src/index.ts",
    "tenant/index": "src/tenant/index.ts",
    "auth/index": "src/auth/index.ts",
    "crud/index": "src/crud/index.ts",
    "queue/index": "src/queue/index.ts",
    "mail/index": "src/mail/index.ts",
    "storage/index": "src/storage/index.ts",
    "config/index": "src/config/index.ts",
    "database/index": "src/database/index.ts",
    "utils/index": "src/utils/index.ts",
    "test/index": "src/test/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
});
