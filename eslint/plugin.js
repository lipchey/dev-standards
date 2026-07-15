/* ONE shared plugin object: overlapping flat-config entries must register this
   exact object because ESLint rejects the same plugin name when its object
   identity changes. Custom rule ids — never shared `no-restricted-syntax`
   entries — because flat config REPLACES (never merges) same-rule options, so a
   shared no-restricted-syntax config would silently erase the consumer's own
   naming gate (or vice-versa); a distinct rule id cannot collide. */

const CONSTANTS_HOME_MESSAGE =
  "value constants never sit inline in logic files — move it to the workspace " +
  "constants home (e.g. src/constants/) or a seam-local constants.ts; derived " +
  "values and option-defaults OBJECTS stay put";

/* Bare primitive VALUE initializers only (number/string/boolean, unary +/- on a
   numeric literal, expressionless template, each also under a TS `as` cast).
   Deliberately NOT caught here: arithmetic operands (`45 * 60 * 1000`) belong to
   the inlineLiterals preset; object/array literals and derived values stay
   review-owned (ADR-017, naming-and-constants profile). */
function isPrimitiveLiteralInit(node) {
  if (!node) return false;
  if (node.type === "TSAsExpression") return isPrimitiveLiteralInit(node.expression);
  if (node.type === "Literal") {
    /* Regex literals are executable patterns rather than value constants. */
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

/* Module scope = the declaration hangs directly off Program, bare or via a
   single ExportNamedDeclaration. Function/block locals are never a
   constants-home hit — inlineLiterals and review own those. */
function isModuleScope(declaration) {
  const parent = declaration.parent;
  if (!parent) return false;
  if (parent.type === "Program") return true;
  return parent.type === "ExportNamedDeclaration" && parent.parent?.type === "Program";
}

const constantsHomeRule = {
  meta: {
    type: "suggestion",
    docs: { description: "value constants belong in a constants home, not inline in logic files" },
    schema: [],
    messages: { inline: CONSTANTS_HOME_MESSAGE },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind !== "const" || !isModuleScope(node)) return;
        for (const declaration of node.declarations) {
          if (isPrimitiveLiteralInit(declaration.init)) {
            context.report({ node: declaration, messageId: "inline" });
          }
        }
      },
    };
  },
};

function isTypeDeclaration(node) {
  return node?.type === "TSInterfaceDeclaration" || node?.type === "TSTypeAliasDeclaration";
}

function topLevelTypeDeclaration(statement) {
  if (isTypeDeclaration(statement)) {
    return { declaration: statement, directlyExported: false };
  }
  if (
    (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") &&
    isTypeDeclaration(statement.declaration)
  ) {
    return { declaration: statement.declaration, directlyExported: true };
  }
  return undefined;
}

function collectExportedTypeDeclarations(program) {
  const declarationsByName = new Map();
  const exportedDeclarations = new Set();

  for (const statement of program.body) {
    const record = topLevelTypeDeclaration(statement);
    if (!record || record.declaration.declare) continue;

    const declarationName = record.declaration.id?.name;
    if (declarationName) {
      const matchingDeclarations = declarationsByName.get(declarationName) ?? [];
      matchingDeclarations.push(record.declaration);
      declarationsByName.set(declarationName, matchingDeclarations);
    }
    if (record.directlyExported) exportedDeclarations.add(record.declaration);
  }

  const markNameExported = (declarationName) => {
    for (const declaration of declarationsByName.get(declarationName) ?? []) {
      exportedDeclarations.add(declaration);
    }
  };

  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration" && !statement.source) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ExportSpecifier" && specifier.local.type === "Identifier") {
          markNameExported(specifier.local.name);
        }
      }
    }
    if (statement.type === "ExportDefaultDeclaration" && statement.declaration.type === "Identifier") {
      markNameExported(statement.declaration.name);
    }
  }

  return exportedDeclarations;
}

const typesHomeRule = {
  meta: {
    type: "suggestion",
    docs: { description: "exported interfaces and type aliases belong in a types home" },
    schema: [
      {
        type: "object",
        properties: { allowNamePattern: { type: "string" } },
        additionalProperties: false,
      },
    ],
    messages: {
      misplaced:
        "dev-standards/types-home: exported type '{{ name }}' belongs in the workspace types home; move the declaration there or scope this preset's ignores to the types-home file.",
    },
  },
  create(context) {
    const allowedNamePattern = new RegExp(context.options[0]?.allowNamePattern ?? "Props$");
    return {
      "Program:exit"(program) {
        for (const declaration of collectExportedTypeDeclarations(program)) {
          const declarationName = declaration.id?.name;
          if (declarationName && allowedNamePattern.test(declarationName)) continue;
          context.report({
            node: declaration,
            messageId: "misplaced",
            data: { name: declarationName ?? "default interface" },
          });
        }
      },
    };
  },
};

const PROPERTY_NAMING_MESSAGE =
  "dev-standards/property-naming: property '{{ name }}' is too short (min 3 chars); rename it descriptively, or ignore the wire-contract file when the external key is fixed.";

/* The statically-known author-chosen key name: identifiers, string-literal keys
   (`"id": string`), and computed keys whose expression is a string literal
   (`["id"]: string`) — a quoted spelling must not bypass the floor. Genuinely
   dynamic computed keys carry no author-chosen name here and are exempt. */
function staticPropertyKeyName(node) {
  if (node.key.type === "Identifier" && !node.computed) return node.key.name;
  if (node.key.type === "Literal" && typeof node.key.value === "string") return node.key.value;
  return undefined;
}

const propertyNamingRule = {
  meta: {
    type: "suggestion",
    docs: { description: "TypeScript property signatures use names of at least three characters" },
    schema: [],
    messages: { tooShort: PROPERTY_NAMING_MESSAGE },
  },
  create(context) {
    return {
      TSPropertySignature(node) {
        const keyName = staticPropertyKeyName(node);
        if (keyName === undefined || keyName === "_" || keyName.length >= 3) return;
        context.report({ node: node.key, messageId: "tooShort", data: { name: keyName } });
      },
    };
  },
};

export const devStandardsPlugin = {
  rules: {
    "constants-home": constantsHomeRule,
    "types-home": typesHomeRule,
    "property-naming": propertyNamingRule,
  },
};
