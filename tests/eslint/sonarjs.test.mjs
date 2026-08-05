import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "eslint-plugin-sonarjs";
import { sonarjs } from "../../eslint/sonarjs.js";
import { buildDispositions } from "./sonarjs-fixture.mjs";

const CATALOG = Object.keys(plugin.rules);
/* A configurable rule with an object-shaped options schema — the vehicle for the
   options-validation teeth. Resolved from the catalog rather than hardcoded so a
   plugin upgrade that drops it fails loudly here instead of silently skipping. */
const CONFIGURABLE_RULE = "no-nested-functions";
const CONFIGURABLE_OPTIONS = [{ threshold: 3 }];

test("the fixture builder is a rule of the installed plugin", () => {
  assert.ok(Object.hasOwn(plugin.rules, CONFIGURABLE_RULE), `${CONFIGURABLE_RULE} left the catalog`);
});

test("builds a flat config covering the whole runtime catalog", () => {
  const [config] = sonarjs({ dispositions: buildDispositions() });
  assert.deepEqual(Object.keys(config.plugins), ["sonarjs"]);
  assert.equal(Object.keys(config.rules).length, CATALOG.length);
  for (const ruleName of CATALOG) {
    assert.ok(Object.hasOwn(config.rules, `sonarjs/${ruleName}`), `missing sonarjs/${ruleName}`);
  }
});

test("emits only error or off — never warn", () => {
  const [config] = sonarjs({
    dispositions: buildDispositions({
      "no-identical-expressions": { disposition: "error", reason: "enabled" },
      [CONFIGURABLE_RULE]: { disposition: "error", reason: "enabled", options: CONFIGURABLE_OPTIONS },
    }),
  });
  for (const [ruleId, entry] of Object.entries(config.rules)) {
    const severity = Array.isArray(entry) ? entry[0] : entry;
    assert.ok(["error", "off"].includes(severity), `${ruleId} resolved to ${JSON.stringify(severity)}`);
  }
  assert.deepEqual(config.rules[`sonarjs/${CONFIGURABLE_RULE}`], ["error", ...CONFIGURABLE_OPTIONS]);
  assert.equal(config.rules["sonarjs/no-identical-expressions"], "error");
});

test("scopes to the given files and omits the key when none are given", () => {
  const dispositions = buildDispositions();
  assert.deepEqual(sonarjs({ dispositions, files: ["src/**/*.ts"] })[0].files, ["src/**/*.ts"]);
  assert.ok(!Object.hasOwn(sonarjs({ dispositions })[0], "files"));
});

/* --- tooth 1: the map must cover the catalog exactly --------------------- */

test("rejects a map missing any rule of the catalog", () => {
  const dispositions = buildDispositions();
  delete dispositions[CATALOG[0]];
  assert.throws(
    () => sonarjs({ dispositions }),
    new RegExp(`${CATALOG[0]}: no disposition`),
  );
});

test("rejects a missing map outright", () => {
  assert.throws(() => sonarjs(), TypeError);
  assert.throws(() => sonarjs({ dispositions: [] }), TypeError);
});

/* --- tooth 2: unknown rule ids ------------------------------------------ */

test("rejects a rule id the installed plugin does not ship", () => {
  assert.throws(
    () => sonarjs({ dispositions: buildDispositions({ "no-such-sonarjs-rule": { disposition: "off", reason: "unproven", note: "typo" } }) }),
    /no-such-sonarjs-rule: not a rule of the installed eslint-plugin-sonarjs/,
  );
});

/* --- tooth 3: options must satisfy the rule's own schema ----------------- */

test("rejects an unknown options key on an enabled configurable rule", () => {
  assert.throws(
    () =>
      sonarjs({
        dispositions: buildDispositions({
          [CONFIGURABLE_RULE]: { disposition: "error", reason: "enabled", options: [{ threshhold: 3 }] },
        }),
      }),
    /no-nested-functions: options rejected by the rule schema/,
  );
});

test("rejects an enabled configurable rule that leaves its threshold implicit", () => {
  assert.throws(
    () =>
      sonarjs({
        dispositions: buildDispositions({
          [CONFIGURABLE_RULE]: { disposition: "error", reason: "enabled" },
        }),
      }),
    /no-nested-functions: is configurable and enabled, so explicit options are required/,
  );
});

/* Each of these satisfies the rule's own JSON schema yet supplies no own, defined
   threshold, so ESLint merges `meta.defaultOptions` back in and the emitted
   `["error", …]` behaves exactly like a bare `"error"`. */
test("rejects options that pass the schema but leave the default in place", () => {
  const sparse = [];
  sparse.length = 1;
  for (const options of [[], [{}], [{ threshold: undefined }], [Object.create({ threshold: 3 })], sparse]) {
    assert.throws(
      () =>
        sonarjs({
          dispositions: buildDispositions({
            [CONFIGURABLE_RULE]: { disposition: "error", reason: "enabled", options },
          }),
        }),
      /no-nested-functions: options\[0\]\.threshold is left to the plugin's built-in default/,
      `accepted options ${JSON.stringify(options)}`,
    );
  }
});

/* A partial options object is the subtle case: it validates, it clearly states
   SOMETHING, and every property it omits still arrives from meta.defaultOptions. */
test("rejects a partial options object that restates only some defaulted keys", () => {
  const partial = () =>
    sonarjs({
      dispositions: buildDispositions({
        "no-duplicate-string": { disposition: "error", reason: "enabled", options: [{ ignoreStrings: "zzz" }] },
      }),
    });
  assert.throws(partial, /no-duplicate-string: options\[0\]\.threshold is left to the plugin's built-in default/);
  assert.doesNotThrow(() =>
    sonarjs({
      dispositions: buildDispositions({
        "no-duplicate-string": {
          disposition: "error",
          reason: "enabled",
          options: [{ threshold: 9, ignoreStrings: "zzz" }],
        },
      }),
    }),
  );
});

/* A positionally-defaulted rule (`cognitive-complexity` defaults to `[15]`) has no
   property to name, so the whole slot is the required path. */
test("rejects a missing positional option value", () => {
  assert.throws(
    () =>
      sonarjs({
        dispositions: buildDispositions({
          "cognitive-complexity": { disposition: "error", reason: "enabled", options: [] },
        }),
      }),
    /cognitive-complexity: options\[0\] is left to the plugin's built-in default/,
  );
  assert.doesNotThrow(() =>
    sonarjs({
      dispositions: buildDispositions({
        "cognitive-complexity": { disposition: "error", reason: "enabled", options: [12] },
      }),
    }),
  );
});

test("ignores entry fields that are only inherited from a prototype", () => {
  const inherited = Object.create({ disposition: "off", reason: "unproven", note: "inherited" });
  assert.throws(
    () => sonarjs({ dispositions: buildDispositions({ "no-identical-expressions": inherited }) }),
    /no-identical-expressions: disposition must be "error" or "off", got undefined/,
  );
});

/* ESLint reads `meta.schema: false` as "options exist but are not validated". No
   rule of 4.2.0 ships that shape, so `isConfigurable` can treat a missing schema
   as "takes no options" — this tripwire makes a plugin upgrade that introduces
   the shape an explicit decision instead of a silent default-inheriting rule. */
test("no installed rule disables its own options validation", () => {
  const unvalidated = Object.entries(plugin.rules)
    .filter(([, rule]) => rule.meta?.schema === false)
    .map(([ruleName]) => ruleName);
  assert.deepEqual(unvalidated, [], "these rules take unvalidated options — teach the factory about them");
});

test("rejects options on a rule that takes none and on a disabled rule", () => {
  assert.throws(
    () =>
      sonarjs({
        dispositions: buildDispositions({
          "no-identical-expressions": { disposition: "error", reason: "enabled", options: [{ threshold: 3 }] },
        }),
      }),
    /no-identical-expressions: takes no options/,
  );
  assert.throws(
    () =>
      sonarjs({
        dispositions: buildDispositions({
          [CONFIGURABLE_RULE]: { disposition: "off", reason: "unproven", note: "n/a", options: CONFIGURABLE_OPTIONS },
        }),
      }),
    /no-nested-functions: options are only meaningful on an enabled rule/,
  );
});

/* --- tooth 4: only error or off ----------------------------------------- */

test("rejects warn and every other severity spelling", () => {
  for (const disposition of ["warn", 1, 2, "Error", true, null]) {
    assert.throws(
      () => sonarjs({ dispositions: buildDispositions({ "no-identical-expressions": { disposition, reason: "enabled" } }) }),
      /no-identical-expressions: disposition must be "error" or "off"/,
      `accepted disposition ${JSON.stringify(disposition)}`,
    );
  }
});

/* --- the closed reason vocabulary (DQ1-D3) ------------------------------- */

test("rejects a reason outside the closed vocabulary", () => {
  for (const reason of ["because", "overlap", "overlap:", "owned-elsewhere:  ", undefined]) {
    assert.throws(
      () => sonarjs({ dispositions: buildDispositions({ "no-identical-expressions": { disposition: "off", reason, note: "x" } }) }),
      /no-identical-expressions: unknown reason/,
      `accepted reason ${JSON.stringify(reason)}`,
    );
  }
  assert.doesNotThrow(() =>
    sonarjs({
      dispositions: buildDispositions({
        "no-identical-expressions": { disposition: "off", reason: "overlap:eqeqeq", note: "core rule already flags it" },
      }),
    }),
  );
});

test("rejects an empty note on any reason other than enabled", () => {
  for (const note of ["", "   ", undefined, 7]) {
    assert.throws(
      () => sonarjs({ dispositions: buildDispositions({ "no-identical-expressions": { disposition: "off", reason: "hotspot-review", note } }) }),
      /no-identical-expressions: reason "hotspot-review" requires a non-empty note/,
      `accepted note ${JSON.stringify(note)}`,
    );
  }
});

test("keeps disposition and reason coherent in both directions", () => {
  assert.throws(
    () => sonarjs({ dispositions: buildDispositions({ "no-identical-expressions": { disposition: "off", reason: "enabled" } }) }),
    /reason "enabled" requires disposition "error"/,
  );
  assert.throws(
    () => sonarjs({ dispositions: buildDispositions({ "no-identical-expressions": { disposition: "error", reason: "unproven", note: "x" } }) }),
    /disposition "error" requires reason "enabled"/,
  );
});

test("rejects an unknown entry key and a non-object entry", () => {
  assert.throws(
    () => sonarjs({ dispositions: buildDispositions({ "no-identical-expressions": { disposition: "error", reason: "enabled", option: [] } }) }),
    /no-identical-expressions: unknown entry key `option`/,
  );
  assert.throws(
    () => sonarjs({ dispositions: buildDispositions({ "no-identical-expressions": "error" }) }),
    /no-identical-expressions: entry must be an object/,
  );
});

test("reports every offending rule at once, not just the first", () => {
  const dispositions = buildDispositions({
    "no-identical-expressions": { disposition: "warn", reason: "enabled" },
    [CONFIGURABLE_RULE]: { disposition: "error", reason: "enabled" },
  });
  delete dispositions[CATALOG.at(-1)];
  assert.throws(() => sonarjs({ dispositions }), (error) => {
    assert.match(error.message, /no-identical-expressions: disposition must be/);
    assert.match(error.message, /no-nested-functions: is configurable and enabled/);
    assert.match(error.message, new RegExp(`${CATALOG.at(-1)}: no disposition`));
    return true;
  });
});
