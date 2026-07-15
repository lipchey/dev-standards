/* Naming floor, all stacks: every identifier the CONSUMER'S AUTHORS choose is
   >=3 chars and ASCII. Promoted from the ai-prompter pilot (owner rules, its
   PR #10; alias hole closed in its PR #21) so every new consumer gets the floor
   from day one instead of rediscovering it. Enforced via no-restricted-syntax
   rather than id-length so each report carries an AI-actionable message and the
   lanes id-length misses (imports, shorthand and destructured bindings) are
   covered.

   This preset OWNS `no-restricted-syntax` within its scope — flat config
   REPLACES same-rule options, so a consumer block that also sets
   no-restricted-syntax on the same files would silently erase this floor (or be
   erased). Repo-specific selectors therefore go through `extraRestrictedSyntax`,
   never a separate block on overlapping files.

   The floor deliberately does NOT judge meaning: what counts as a meaningful
   name (whole English words + a blessed-abbreviation allowlist) is the
   consumer's `.claude/code-conventions.md` §Naming and language — an
   OPERATIONAL standard per the code-conventions template. Deliberately NOT
   enforced here: object-literal PROPERTY keys (wire contracts pin short keys)
   and the `_` discard. TYPE property signatures are owned by the separate
   `propertyNaming` preset (file-scoped wire exemptions, ADR-018). */

const NAME_TOO_SHORT =
  "Identifier too short (min 3 chars) — this gate is only the length/ASCII floor. For what counts as a meaningful name (English words + the blessed-abbreviation allowlist), see .claude/code-conventions.md §Naming and language.";

/* Build the named-import selector with the consumer's exemptions inlined: a
   framework-canonical short external name (vitest's `vi` is the seed) gets an
   explicit :not() added in the same PR that introduces it. esquery cannot
   compare imported.name to local.name, so aliases and plain short externals
   take the same floor. */
function namedImportSelector(exemptNamedImports) {
  if (!Array.isArray(exemptNamedImports)) {
    throw new Error("naming(): exemptNamedImports must be an array of plain identifiers");
  }
  for (const name of exemptNamedImports) {
    /* Interpolated into an esquery selector: anything but a plain identifier
       STRING would silently corrupt the selector (or widen the exemption) — a
       coercible object could even pass a regex test and interpolate something
       else, so the type check is part of the guard, not pedantry. */
    if (typeof name !== "string" || !/^[a-z_$][\w$]*$/i.test(name)) {
      throw new Error(`naming(): exemptNamedImports entry is not a plain identifier: ${JSON.stringify(name)}`);
    }
  }
  const nots = exemptNamedImports.map((name) => `:not([name='${name}'])`).join("");
  return `ImportSpecifier > Identifier.local[name.length<3]${nots}`;
}

export function naming({ files, ignores, exemptNamedImports = ["vi"], extraRestrictedSyntax = [] } = {}) {
  const entry = {
    rules: {
      "id-match": ["error", "^[\\u0021-\\u007E]+$", { properties: true, classFields: true }],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "VariableDeclarator > Identifier.id[name.length<3]:not([name='_']), FunctionDeclaration > Identifier.id[name.length<3], FunctionExpression > Identifier.id[name.length<3], ClassDeclaration > Identifier.id[name.length<3], ClassExpression > Identifier.id[name.length<3]",
          message: NAME_TOO_SHORT,
        },
        {
          /* Params: plain, default (AssignmentPattern), rest, catch, AND TypeScript
             constructor parameter-properties (`constructor(private readonly ab)`),
             which wrap the binding in TSParameterProperty. */
          selector:
            ":function > Identifier.params[name.length<3]:not([name='_']), :function > AssignmentPattern > Identifier.left[name.length<3]:not([name='_']), :function > RestElement > Identifier[name.length<3]:not([name='_']), CatchClause > Identifier.param[name.length<3]:not([name='_']), TSParameterProperty > Identifier.parameter[name.length<3]:not([name='_']), TSParameterProperty > AssignmentPattern > Identifier.left[name.length<3]:not([name='_'])",
          message: NAME_TOO_SHORT,
        },
        {
          selector:
            "ObjectPattern > Property > Identifier.value[name.length<3]:not([name='_']), ObjectPattern > Property > AssignmentPattern > Identifier.left[name.length<3]:not([name='_']), ObjectPattern > RestElement > Identifier[name.length<3]:not([name='_']), ArrayPattern > Identifier[name.length<3]:not([name='_']), ArrayPattern > AssignmentPattern > Identifier.left[name.length<3]:not([name='_']), ArrayPattern > RestElement > Identifier[name.length<3]:not([name='_'])",
          message: NAME_TOO_SHORT,
        },
        {
          /* Class members are names we choose (unlike object/type property keys,
             which wire contracts pin) — enforce them too, including `#private`
             fields/methods (PrivateIdentifier keys). Computed keys are expressions,
             not names, so they are left out. A member whose short name is mandated
             by an implemented interface is the rare case for an inline disable. */
          selector:
            "MethodDefinition[computed=false] > Identifier.key[name.length<3]:not([name='_']), PropertyDefinition[computed=false] > Identifier.key[name.length<3]:not([name='_']), MethodDefinition[computed=false] > PrivateIdentifier.key[name.length<3], PropertyDefinition[computed=false] > PrivateIdentifier.key[name.length<3]",
          message: NAME_TOO_SHORT,
        },
        {
          /* Imports whose LOCAL name we choose: default, namespace, and
             `import x = require()`. */
          selector:
            "ImportDefaultSpecifier > Identifier[name.length<3], ImportNamespaceSpecifier > Identifier[name.length<3], TSImportEqualsDeclaration > Identifier.id[name.length<3]",
          message: NAME_TOO_SHORT,
        },
        {
          selector: namedImportSelector(exemptNamedImports),
          message: NAME_TOO_SHORT,
        },
        ...extraRestrictedSyntax,
      ],
    },
  };
  if (files) entry.files = files;
  if (ignores) entry.ignores = ignores;
  return [entry];
}
