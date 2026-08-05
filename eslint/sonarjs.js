import Ajv from "ajv";
import plugin from "eslint-plugin-sonarjs";

/* This factory holds NO opinion about which SonarJS rules belong on. The
   consumer owns the full disposition matrix; upstream owns only the machinery
   that refuses to build an incomplete or incoherent one (DQ1-D1). The plugin's
   `recommended` config is never spread — every rule is enabled or disabled by
   an explicit, reasoned consumer entry, so a plugin upgrade shows up as a red
   catalog test instead of silently changed behaviour (DQ1-D2, DQ1-D8). */

const PLUGIN_NAMESPACE = "sonarjs";

/* `error` or `off` only: lifelong `warn` is banned by the standard, and ESLint
   bulk suppressions act on `error` alone (DQ1-D4). */
const DISPOSITIONS = ["error", "off"];
const ENABLED = "error";

/* Closed reason vocabulary (DQ1-D3). The qualified ones carry a `:<detail>`
   suffix naming the overlapping rule or the gate that owns the class. */
const PLAIN_REASONS = ["enabled", "hotspot-review", "unproven", "style-not-defect", "cost-exceeds-value"];
const QUALIFIED_REASONS = ["overlap", "owned-elsewhere"];
const ENABLED_REASON = "enabled";
const REASON_SEPARATOR = ":";

const ENTRY_KEYS = ["disposition", "reason", "note", "options"];

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const isKnownReason = (reason) => {
  if (typeof reason !== "string") return false;
  if (PLAIN_REASONS.includes(reason)) return true;
  const separator = reason.indexOf(REASON_SEPARATOR);
  if (separator < 0) return false;
  return (
    QUALIFIED_REASONS.includes(reason.slice(0, separator)) &&
    reason.slice(separator + REASON_SEPARATOR.length).trim() !== ""
  );
};

/* An ESLint rule may declare its options either as a positional list of item
   schemas or as one whole-array schema; normalize to the latter so a single
   validator covers both shapes across plugin versions. */
const normalizeSchema = (schema) =>
  Array.isArray(schema) ? { type: "array", items: schema, minItems: 0, maxItems: schema.length } : schema;

const isConfigurable = (schema) =>
  schema !== undefined && schema !== false && !(Array.isArray(schema) && schema.length === 0);

/* Schema validity is NOT explicitness. Every rule declares `meta.defaultOptions`,
   and ESLint merges it into whatever the consumer supplies — verified on 4.2.0:
   `["error", {ignoreStrings: "zzz"}]` for `no-duplicate-string` still runs at the
   built-in `threshold: 3`. So the defaults are precisely the set of values that
   stay implicit unless restated, and DQ1-D6 forbids inheriting any of them.
   Reading the list off the plugin keeps this file free of rule knowledge: the
   plugin declares what it would default, not us. */
const defaultedPaths = (defaults) =>
  Array.isArray(defaults)
    ? defaults.flatMap((item, index) => {
        if (isPlainObject(item)) return Object.keys(item).map((key) => ({ index, key }));
        return item === undefined ? [] : [{ index, key: undefined }];
      })
    : [];

/* Own and defined: a value reachable only through the item's prototype is not one
   the matrix states. A missing or sparse slot reads as `undefined` and falls to
   the same two checks. */
const isSupplied = (options, { index, key }) => {
  const item = options[index];
  if (key === undefined) return item !== undefined;
  return isPlainObject(item) && Object.hasOwn(item, key) && item[key] !== undefined;
};

const describePath = ({ index, key }) =>
  key === undefined ? `options[${index}]` : `options[${index}].${key}`;

/* @param {{ dispositions: Record<string, object>, files?: string[] }} input */
export const sonarjs = ({ dispositions, files } = {}) => {
  if (!isPlainObject(dispositions)) {
    throw new TypeError(
      "sonarjs preset: `dispositions` must be a map covering every rule of the installed plugin",
    );
  }

  const catalog = Object.keys(plugin.rules);
  const problems = [];

  for (const ruleName of Object.keys(dispositions)) {
    if (!Object.hasOwn(plugin.rules, ruleName)) {
      problems.push(`${ruleName}: not a rule of the installed eslint-plugin-sonarjs`);
    }
  }
  for (const ruleName of catalog) {
    if (!Object.hasOwn(dispositions, ruleName)) {
      problems.push(`${ruleName}: no disposition — the map must cover the whole rule catalog`);
    }
  }

  const ajv = new Ajv({ strict: false });
  const rules = {};

  for (const ruleName of catalog) {
    if (!Object.hasOwn(dispositions, ruleName)) continue;
    const entry = dispositions[ruleName];
    if (!isPlainObject(entry)) {
      problems.push(`${ruleName}: entry must be an object`);
      continue;
    }

    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key)) problems.push(`${ruleName}: unknown entry key \`${key}\``);
    }

    /* Read OWN fields only: destructuring `entry` directly would happily consume a
       `disposition` or `reason` inherited from a prototype — a field the entry does
       not actually state, and one the own-key check above never sees. */
    const { disposition, reason, note, options } = Object.fromEntries(Object.entries(entry));

    if (!DISPOSITIONS.includes(disposition)) {
      problems.push(
        `${ruleName}: disposition must be "error" or "off", got ${JSON.stringify(disposition)}`,
      );
    }

    if (!isKnownReason(reason)) {
      problems.push(`${ruleName}: unknown reason ${JSON.stringify(reason)}`);
    } else if (reason === ENABLED_REASON) {
      if (disposition !== ENABLED) {
        problems.push(`${ruleName}: reason "${ENABLED_REASON}" requires disposition "${ENABLED}"`);
      }
    } else {
      if (disposition === ENABLED) {
        problems.push(`${ruleName}: disposition "${ENABLED}" requires reason "${ENABLED_REASON}"`);
      }
      if (typeof note !== "string" || note.trim() === "") {
        problems.push(`${ruleName}: reason "${reason}" requires a non-empty note`);
      }
    }

    const schema = plugin.rules[ruleName].meta?.schema;
    const defaulted = defaultedPaths(plugin.rules[ruleName].meta?.defaultOptions);

    if (options !== undefined) {
      if (disposition !== ENABLED) {
        problems.push(`${ruleName}: options are only meaningful on an enabled rule`);
      } else if (!isConfigurable(schema)) {
        problems.push(`${ruleName}: takes no options`);
      } else if (!Array.isArray(options)) {
        problems.push(`${ruleName}: options must be an array`);
      } else {
        for (const path of defaulted) {
          if (!isSupplied(options, path)) {
            problems.push(`${ruleName}: ${describePath(path)} is left to the plugin's built-in default`);
          }
        }
        const validate = ajv.compile(normalizeSchema(schema));
        if (!validate(options)) {
          problems.push(`${ruleName}: options rejected by the rule schema — ${ajv.errorsText(validate.errors)}`);
        }
      }
    } else if (disposition === ENABLED && defaulted.length > 0) {
      problems.push(`${ruleName}: is configurable and enabled, so explicit options are required`);
    }

    rules[`${PLUGIN_NAMESPACE}/${ruleName}`] =
      disposition === ENABLED && options !== undefined ? [ENABLED, ...options] : disposition;
  }

  if (problems.length > 0) {
    throw new Error(`sonarjs preset: invalid disposition map\n- ${problems.join("\n- ")}`);
  }

  return [{ ...(files === undefined ? {} : { files }), plugins: { [PLUGIN_NAMESPACE]: plugin }, rules }];
};
