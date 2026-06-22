import js from '@eslint/js';
import globals from 'globals';
import pluginVue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'package-lock.json',
      'backend/data/**',
    ],
  },

  js.configs.recommended,

  // Node.js code (backend, agent, tooling, tests)
  {
    files: ['backend/**/*.js', 'agent/**/*.js', 'test/**/*.{js,mjs}', '*.js', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },

  // Vue + browser code (frontend)
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['frontend/**/*.{js,vue}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
    },
  },

  // Disable formatting rules that conflict with Prettier
  prettier,
];
