/**
 * ESLint flat config for the template client (Vite + TS + React 19).
 * Ported standard from auth-provider (T1.5c): lint joins the pre-commit
 * guardrail stages. Keep the rule set minimal and standard — conventions
 * belong to the platform docs, not per-repo footguns.
 */
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage'] },
  {
    files: ['client/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['client/scripts/**/*.{js,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  }
);
