import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "result/index": "src/result/index.ts",
    "ioc/index": "src/ioc/index.ts",
    "logger/index": "src/logger/index.ts",
    "utils/index": "src/utils/index.ts",
    "config-schema/index": "src/config-schema/index.ts",
    "rbac/index": "src/rbac/index.ts",
    "auth/index": "src/auth/index.ts",
    "signing/index": "src/signing/index.ts",
    "vault/index": "src/vault/index.ts",
    "captcha/index": "src/captcha/index.ts",
    "captcha/altcha": "src/captcha/altcha.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
});
