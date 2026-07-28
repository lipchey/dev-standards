import plugin from "eslint-plugin-sonarjs";

/* The factory demands a disposition for every rule of the installed catalog, so
   each test starts from a generated all-off baseline and overrides only what it
   exercises. This is test scaffolding, NOT a recommendation: the real matrix is
   owned by the consumer repo (DQ1-D1). */
export const buildDispositions = (overrides = {}) => {
  const baseline = {};
  for (const ruleName of Object.keys(plugin.rules)) {
    baseline[ruleName] = {
      disposition: "off",
      reason: "unproven",
      note: "upstream test baseline — dispositions are audited in the consumer repo",
    };
  }
  return { ...baseline, ...overrides };
};

/* One enabled rule carries the fixture smoke in tests/eslint/presets.test.mjs.
   Chosen because it needs no type information and no options. */
export const SMOKE_RULE = "no-identical-expressions";
export const SMOKE_DISPOSITIONS = buildDispositions({
  [SMOKE_RULE]: { disposition: "error", reason: "enabled" },
});
