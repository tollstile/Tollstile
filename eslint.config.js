import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import tseslint from 'typescript-eslint';

const layerImports = (forbidden) => ({
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        { group: ['node:*'], message: 'Library code uses Web standard APIs only.' },
        ...forbidden.map((layer) => ({
          group: [`**/${layer}/**`, `../${layer}/**`, `../../${layer}/**`],
          message: `This layer must not import from ${layer}. See CODING_RULES.md §1.`,
        })),
      ],
    },
  ],
});

export default tseslint.config(
  { ignores: ['web/**', '.claude/**', '**/dist/**', '**/node_modules/**', '**/*.config.*'] },
  ...tseslint.configs.strictTypeChecked,
  comments.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@eslint-community/eslint-comments/require-description': 'error',
      'no-useless-catch': 'error',
      'no-console': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Use the injected clock.' },
      ],
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'Library code uses Web standard APIs only.' }] },
      ],
    },
  },
  {
    files: ['packages/express/src/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // A Node CLI: it writes files and talks to the terminal.
    files: ['packages/create-tollstile/src/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', 'no-console': 'off' },
  },
  {
    files: ['packages/tollstile/src/core/**/*.ts'],
    rules: {
      ...layerImports(['policies', 'requirements', 'rails', 'ledgers', 'testing']),
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TryStatement',
          message: 'core does not catch. If recovery is required, disable with a written reason.',
        },
      ],
    },
  },
  {
    files: [
      'packages/tollstile/src/policies/**/*.ts',
      'packages/tollstile/src/requirements/**/*.ts',
      'packages/tollstile/src/rails/**/*.ts',
      'packages/tollstile/src/ledgers/**/*.ts',
    ],
    rules: layerImports(['testing']),
  },
  {
    files: ['packages/*/test/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
);
