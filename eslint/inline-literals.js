const DEFAULT_IGNORED_NUMBERS = [0, 1, -1];

export function inlineLiterals({ files, ignores, ignore = [] } = {}) {
  const entry = {
    /* The consumer's TypeScript ESLint base owns plugin registration; another
       module instance can make overlapping flat config fail during composition. */
    rules: {
      "@typescript-eslint/no-magic-numbers": [
        "error",
        {
          ignore: [...DEFAULT_IGNORED_NUMBERS, ...ignore],
          ignoreArrayIndexes: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
    },
  };
  if (files) entry.files = files;
  if (ignores) entry.ignores = ignores;
  return [entry];
}
