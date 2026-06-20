import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist-electron/**", "out/**", "node_modules/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser
    },
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules
    }
  },
  {
    files: ["electron/**/*.ts", "electron.vite.config.ts", "scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node
    }
  }
);
