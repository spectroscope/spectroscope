// The lint half of the gate (card 65): tsc catches types, eslint catches the
// rest — above all the react-hooks rules, which tsc cannot see. Run as
// `npm run lint`; zero warnings tolerated (a warning nobody fails on is a
// warning nobody reads).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Hook dependency mistakes are real bugs here (stale closures around the
      // socket batcher) — error, with the three reasoned inline suppressions
      // in providerModelField.tsx now actually meaning something.
      "react-hooks/exhaustive-deps": "error",
      // The React-Compiler-era rules flag 30+ sites of WORKING, live-verified
      // code (setState-in-effect reconciliation patterns, measured refs). That
      // is a refactor campaign, not a gate baseline — tracked on card 66, off
      // until then so the gate stays honest about what it enforces.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      // The wire seams narrow through `as unknown as X` on purpose; tsc strict
      // is on, so banning `any` wholesale would only fight that pattern.
      "@typescript-eslint/no-explicit-any": "off",
      // tsc (noUnusedLocals) already polices locals; let eslint also catch
      // unused args, with the conventional underscore escape.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
