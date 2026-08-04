import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Python bake-off harness is not part of the app. Its virtualenv
    // contains JS vendored inside pip packages (PyTorch ships a preact bundle),
    // which eslint will happily crawl and report on.
    "tools/**/.venv/**",
  ]),
]);

export default eslintConfig;
