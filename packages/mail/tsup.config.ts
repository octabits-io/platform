import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "index": "src/index.ts",
    "smtp": "src/smtp.ts",
    "mailjet": "src/mailjet.ts",
    "brevo": "src/brevo.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
});
