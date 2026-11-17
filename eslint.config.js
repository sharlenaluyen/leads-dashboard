import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "data/**"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  // public/app.js runs in the browser as a module.
  { files: ["public/**/*.js"], languageOptions: { globals: globals.browser } },
];
