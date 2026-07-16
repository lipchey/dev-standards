import { devStandardsPlugin } from "./plugin.js";

/* `severity` is a factory param (siblings hardcode "error") because this gate
   ships to consumers on a WARN-first ramp: a consumer passes "warn" during
   calibration on the SAME block that registers the plugin — a separate
   severity-override block would leave `dev-standards` unregistered on any file
   the preset ignores (a declaration file the ignores list drops) and crash
   ESLint with "Could not find plugin" there. Seeds and composition keep the
   default "error". */
export function comparisonLiterals({ files, ignores, severity = "error" } = {}) {
  const entry = {
    plugins: { "dev-standards": devStandardsPlugin },
    rules: { "dev-standards/comparison-literals": severity },
  };
  if (files) entry.files = files;
  if (ignores) entry.ignores = ignores;
  return [entry];
}
