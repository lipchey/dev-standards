import { devStandardsPlugin } from "./plugin.js";

export function propertyNaming({ files, ignores } = {}) {
  const entry = {
    plugins: { "dev-standards": devStandardsPlugin },
    rules: { "dev-standards/property-naming": "error" },
  };
  if (files) entry.files = files;
  if (ignores) entry.ignores = ignores;
  return [entry];
}
