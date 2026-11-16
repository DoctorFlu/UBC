import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      // Agent worktrees are full copies of this repository; linting them multiplies the work
      // several times over and runs the type-aware linter out of memory.
      ".claude/**",
      "**/dist/**",
      "**/.next/**",
      "**/out/**",
      "**/cache/**",
      "**/coverage/**",
      "contracts/**",
      "dashboard/next-env.d.ts",
      "dashboard/playwright-report/**",
      "dashboard/test-results/**",
      "site/next-env.d.ts",
      "site/playwright-report/**",
      "site/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  // The dashboard and the landing page are Next.js apps: browser globals, Next.js rules (Core Web
  // Vitals set) and the React Hooks rules, on top of the shared strict TypeScript rules above.
  {
    files: ["{dashboard,site}/**/*.{ts,tsx}"],
    plugins: {
      "@next/next": nextPlugin,
      "react-hooks": reactHooks,
    },
    settings: {
      next: { rootDir: ["dashboard/", "site/"] },
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.flat.recommended.rules,
      // JSX event handlers routinely return the result of a void call, e.g. onClick={() => setOpen(false)}.
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      // Event handler props accept async functions; React ignores the returned promise by design.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
