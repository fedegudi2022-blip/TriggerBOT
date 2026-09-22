// ESLint 9 (flat config). Enfoque: catching real bugs, no guerras de estilo —
// el formato lo maneja Prettier.
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'data/**', 'coverage/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Errores reales
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-async-promise-executor': 'error',
      'no-dupe-keys': 'error',
      'no-func-assign': 'error',
      'no-irregular-whitespace': 'error',
      'no-redeclare': 'error',
      'no-sparse-arrays': 'error',
      'no-template-curly-in-string': 'error',
      'no-unreachable': 'error',
      'no-unreachable-loop': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      'no-useless-backreference': 'error',
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',

      // Sospechosos comunes en bots (errores silenciosos)
      'eqeqeq': ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-shadow-restricted-names': 'error',
      'no-fallthrough': 'error',
      'no-loss-of-precision': 'error',
      'no-promise-executor-return': ['error', { allowVoid: true }],
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-shadow': ['warn', { builtinGlobals: false, hoist: 'functions' }],
    },
  },
  {
    // Los tests usan asserts y variables "sin usar" a propósito (fábricas).
    files: ['tests/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
      'no-promise-executor-return': 'off',
    },
  },
];
