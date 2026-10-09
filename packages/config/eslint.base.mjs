import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Configuration ESLint de base (flat config) partagée par tous les paquets.
 * Chaque paquet l'étend et ajoute ses règles spécifiques.
 */
export const base = tseslint.config(
  { ignores: ['dist/**', 'build/**', 'coverage/**', '.turbo/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
);

export default base;
