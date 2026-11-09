// ESLint: typescript-eslint's type-aware recommended rules, eslint-plugin-vue's recommended rules, and
// eslint-config-prettier last so that nothing formatting covers is linted.

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['docs/', 'plugin/dist/', 'plugin/evals/results/', 'reports/'],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  vue.configs['flat/recommended'],
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
      globals: globals.browser,
    },
  },
  {
    files: ['src/web/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/cli/**', 'src/server/**', 'e2e/**', '*.config.*', '.github/**/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  prettier,
);
