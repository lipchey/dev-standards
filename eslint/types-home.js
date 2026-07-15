import { devStandardsPlugin } from "./plugin.js";

function validateAllowNamePattern(allowNamePattern) {
  if (typeof allowNamePattern !== "string") {
    throw new Error("typesHome(): allowNamePattern must be a string regex");
  }
  try {
    new RegExp(allowNamePattern);
  } catch (error) {
    throw new Error(`typesHome(): invalid allowNamePattern regex: ${JSON.stringify(allowNamePattern)}`, {
      cause: error,
    });
  }
}

export function typesHome({ files, ignores, allowNamePattern = "Props$" } = {}) {
  validateAllowNamePattern(allowNamePattern);
  const entry = {
    plugins: { "dev-standards": devStandardsPlugin },
    rules: { "dev-standards/types-home": ["error", { allowNamePattern }] },
  };
  if (files) entry.files = files;
  if (ignores) entry.ignores = ignores;
  return [entry];
}
