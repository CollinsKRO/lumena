import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import lumenSecurity from "./scripts/linter/index.js";

export default [
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      lumen: lumenSecurity,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "lumen/no-unsafe-xdr": "error",
      "lumen/no-raw-secret-keys": "error",
    },
  },
  prettierConfig,
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.js"],
  },
];