import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, createDiv: "readonly" },
    },
  },
];
