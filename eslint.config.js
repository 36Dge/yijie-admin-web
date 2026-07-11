import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended, ...pluginVue.configs["flat/essential"]],
    files: ["**/*.{js,mjs,ts,vue}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals["shared-node-browser"],
      parserOptions: { parser: tseslint.parser },
    },
    rules: { "vue/multi-word-component-names": "off" },
  },
  eslintConfigPrettier,
);
