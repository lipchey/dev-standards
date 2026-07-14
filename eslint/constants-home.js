/* Mechanism only: the consumer owns the file/ignore globs (the preset hard-codes
   NO paths). Ships a CUSTOM rule inside an inline plugin, NOT a
   `no-restricted-syntax` config — flat config REPLACES (never merges) same-rule
   options, so a shared `no-restricted-syntax` entry would silently erase the
   consumer's own naming gate (which already uses that rule) or vice-versa. A
   distinct rule id (`dev-standards/constants-home`) cannot collide. */

/* AI-actionable hint, shaped like the consumer's NAME_TOO_SHORT: name the rule
   and the exact fix so an automated fixer knows where the value belongs. */
const MESSAGE =
  "value constants never sit inline in logic files — move it to the workspace " +
  "constants home (e.g. src/constants/) or a seam-local constants.ts; derived " +
  "values and option-defaults OBJECTS stay put";

/* True for an initializer that is a bare primitive VALUE (number/string/boolean),
   including a unary +/- on a numeric literal and an expressionless template — and
   the same wrapped in a TS `as`-cast (`500 as const`). Node-type guards keep this
   inert under non-TS parsers that never emit TSAsExpression. Deliberately NOT
   caught (review-owned ceiling): arithmetic like `45 * 60 * 1000` (BinaryExpression),
   object/array literals, and anything referencing another binding. */
function isPrimitiveLiteralInit(node) {
  if (!node) return false;
  if (node.type === "TSAsExpression") return isPrimitiveLiteralInit(node.expression);
  if (node.type === "Literal") {
    /* a regex literal is not a value constant */
    if ("regex" in node) return false;
    const kind = typeof node.value;
    return kind === "number" || kind === "string" || kind === "boolean";
  }
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    return node.argument.type === "Literal" && typeof node.argument.value === "number";
  }
  return false;
}

/* Module scope = the declaration hangs directly off Program, either bare or via a
   single ExportNamedDeclaration. Anything under a function/block is a local and is
   the review-owned ceiling, never a gate hit. */
function isModuleScope(declaration) {
  const parent = declaration.parent;
  if (!parent) return false;
  if (parent.type === "Program") return true;
  return parent.type === "ExportNamedDeclaration" && parent.parent?.type === "Program";
}

const rule = {
  meta: {
    type: "suggestion",
    docs: { description: "value constants belong in a constants home, not inline in logic files" },
    schema: [],
    messages: { inline: MESSAGE },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind !== "const" || !isModuleScope(node)) return;
        for (const decl of node.declarations) {
          if (isPrimitiveLiteralInit(decl.init)) context.report({ node: decl, messageId: "inline" });
        }
      },
    };
  },
};

/* files/ignores are passed through VERBATIM: `files` = the consumer's workspace src
   globs, `ignores` = its constants homes / tests / configs. One entry defines the
   inline plugin and enables its rule under the same scope, so the plugin is only
   registered where the rule runs. */
export function constantsHome({ files, ignores } = {}) {
  const entry = {
    plugins: { "dev-standards": { rules: { "constants-home": rule } } },
    rules: { "dev-standards/constants-home": "error" },
  };
  if (files) entry.files = files;
  if (ignores) entry.ignores = ignores;
  return [entry];
}
