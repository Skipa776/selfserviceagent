// ESLint flat config (ESLint 10). Lints TypeScript via typescript-eslint.
// Lazy on purpose: the two recommended presets, plus global ignores. Add rules
// only when a real bug slips past these — not speculatively.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
