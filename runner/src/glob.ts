/**
 * Restricted glob matcher for the manifest fileset dialect.
 *
 * Only the dialect the schema accepts is supported (validation rejects `?`,
 * `[`, `{` before any pattern reaches here):
 *   - star  — zero or more characters within a single path segment; never `/`.
 *   - doublestar — any number of path segments; a leading doublestar-slash
 *            matches zero or more directories, so `doublestar-slash + *.ts`
 *            matches both `validate.ts` and `runner/src/validate.ts`.
 *   - literal segments — matched verbatim, anchored end-to-end.
 *
 * The pattern is translated once to an anchored `RegExp`. We scan the pattern
 * left to right so that escaping of literal text and the doublestar / star
 * cases compose cleanly without re-matching already-translated output:
 *   - doublestar then slash -> `(?:.*[/])?`  (slash optional, can match zero dirs)
 *   - doublestar alone      -> `.*`          (a trailing or bare doublestar, crosses `/`)
 *   - star                  -> `[^/]*`       (single segment only)
 *   - any other char is escaped as a regex literal.
 */
export function matches(path: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(path);
}

/** Regex metacharacters that must be escaped when a pattern char is a literal. */
const REGEX_META = /[.*+?^${}()|[\]\\]/;

function patternToRegExp(pattern: string): RegExp {
  let body = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**`: consume the second star, then optionally the following slash.
        if (pattern[i + 2] === '/') {
          body += '(?:.*/)?';
          i += 2; // consumed second `*` and the `/`
        } else {
          body += '.*';
          i += 1; // consumed second `*`
        }
      } else {
        body += '[^/]*';
      }
      continue;
    }
    // `char` is a single literal character (never undefined within range).
    body += REGEX_META.test(char as string) ? `\\${char}` : char;
  }
  return new RegExp(`^${body}$`);
}
