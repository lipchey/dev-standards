import { devStandardsPlugin } from "./plugin.js";

export function propertyNaming({ files, ignores, allow } = {}) {
  /* An unscoped `allow` exempts those keys in every linted file, blinding the rule's main
     catch class repo-wide rather than at the module whose contract fixes them. */
  if (allow !== undefined && !files?.length) {
    throw new Error(
      "propertyNaming: `allow` requires `files` — scope the key exemption to the modules whose external contract fixes those keys.",
    );
  }
  const entry = {
    plugins: { "dev-standards": devStandardsPlugin },
    rules: {
      "dev-standards/property-naming": allow?.length ? ["error", { allow }] : "error",
    },
  };
  if (files) entry.files = files;
  if (ignores) entry.ignores = ignores;
  return [entry];
}
