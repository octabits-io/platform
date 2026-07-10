import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "index": "src/index.ts",
    "smtp": "src/smtp.ts",
    "mailjet": "src/mailjet.ts",
    "brevo": "src/brevo.ts",
  },
  format: "esm",
  // Emit .js/.d.ts (matching the exports map) instead of tsdown's default .mjs/.d.mts.
  fixedExtension: false,
  dts: true,
  clean: true,
});
