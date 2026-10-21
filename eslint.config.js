import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', '.claude/worktrees/']),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts', 'vite.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The viewer runs in a browser.
    files: ['src/viewer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/viewer/**/*.{ts,tsx}'],
    ignores: ['src/viewer/**/*.test.{ts,tsx}', 'src/viewer/testing.tsx'],
    rules: {
      // Repository and model text is untrusted (spec invariant 6). Tests may build pages directly.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Render repository and model text as React text, never as HTML.',
        },
        {
          selector:
            'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]',
          message: 'Render repository and model text as React text, never as HTML.',
        },
        {
          selector:
            'CallExpression[callee.property.name=/^(insertAdjacentHTML|write|writeln|createContextualFragment)$/]',
          message: 'Render repository and model text as React text, never as HTML.',
        },
      ],
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'The viewer runs in a browser.' }] },
      ],
    },
  },
  prettier,
);
