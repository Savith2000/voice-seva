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
    // Installed agent skills. Third-party payload fetched by `npx skills add`,
    // gitignored, and not ours to lint or fix — it ships its own scripts using
    // require() and other styles this config forbids. .claude/skills is only
    // symlinks into .agents.
    ".agents/**",
    ".claude/skills/**",
    // ONNX Runtime's minified WASM loaders, copied out of node_modules by
    // tools/copy-ort-wasm.mjs. Vendor output, not ours to lint.
    "public/ort/**",
  ]),
]);

export default eslintConfig;
