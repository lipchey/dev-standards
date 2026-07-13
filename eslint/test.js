import vitest from "@vitest/eslint-plugin";

const TEST_FILES = ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"];

/* no-focused=error fails CI on a stray `.only` earlier than Vitest's own
   allowOnly (which guards CI runs only, not editor or pre-commit). no-disabled
   stays warn: an intentional `.skip` for a platform/external dependency is
   legitimate, so surface it, do not block. `files` after the spread so the
   preset's own scope wins over any glob the upstream config carries. */
export const test = [
  {
    ...vitest.configs.recommended,
    files: TEST_FILES,
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "warn",
    },
  },
];
