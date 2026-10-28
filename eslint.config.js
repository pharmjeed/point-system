import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', 'brand/**', '**/coverage/**', 'apps/web/public/**', '**/playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // Domain code and use-cases never read the wall clock directly (05 §7.5).
    files: ['packages/server/src/modules/*/domain/**/*.ts', 'packages/server/src/use-cases/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Use the injected Clock.' },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Use the injected Clock.' },
      ],
    },
  },
);
