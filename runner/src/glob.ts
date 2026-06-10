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
 * The pattern is parsed once into a flat token list and matched against the
 * path with a bottom-up dynamic program over (token index, path index). That is
 * O(tokens × path length) with NO backtracking, so a pattern built from many
 * doublestars cannot trigger catastrophic (exponential) matching — the failure
 * mode of the previous translate-to-RegExp approach, where adjacent `.*` groups
 * backtracked combinatorially.
 *
 * Each token is exactly equivalent to the RegExp atom the old translation used,
 * so behaviour is preserved end to end:
 *   - doublestar then slash -> `(?:.*[/])?`  (slash optional, can match zero dirs)
 *   - doublestar alone      -> `.*`          (a trailing or bare doublestar, crosses `/`)
 *   - star                  -> `[^/]*`       (single segment only)
 *   - literal char          -> that exact character
 */
export function matches(path: string, pattern: string): boolean {
  const tokens = tokenize(pattern);
  const n = path.length;
  const m = tokens.length;

  // `next[i]` answers "do tokens[j+1..] match path[i..]?"; `cur[i]` is the same
  // for column j. Base column j = m (no tokens left) matches only the path end.
  let next = new Uint8Array(n + 1);
  next[n] = 1;

  for (let j = m - 1; j >= 0; j -= 1) {
    const token = tokens[j] as Token;
    const cur = new Uint8Array(n + 1);
    // For `globslash`, `taken` tracks whether `.*` followed by a terminating
    // slash (the non-empty branch) then tokens[j+1..] matches from the current
    // index. Carried as i descends, it costs O(1) per cell instead of a rescan.
    let taken = false;
    for (let i = n; i >= 0; i -= 1) {
      const ch = path[i]; // undefined only at i === n, and then never read
      let ok = false;
      switch (token.kind) {
        case 'lit':
          ok = i < n && ch === token.ch && next[i + 1] === 1;
          break;
        case 'star': // [^/]* : match zero, or one non-slash char and stay
          ok = next[i] === 1 || (i < n && ch !== '/' && cur[i + 1] === 1);
          break;
        case 'globstar': // .* : match zero, or any one char and stay
          ok = next[i] === 1 || (i < n && cur[i + 1] === 1);
          break;
        case 'globslash': {
          // (?:.*[/])? : the empty branch is `next[i]`; the taken branch ends
          // the run at a slash here (`next[i + 1]`) or keeps consuming (`taken`).
          taken = i < n && ((ch === '/' && next[i + 1] === 1) || taken);
          ok = next[i] === 1 || taken;
          break;
        }
      }
      cur[i] = ok ? 1 : 0;
    }
    next = cur;
  }

  return next[0] === 1;
}

type Token =
  | { kind: 'lit'; ch: string }
  | { kind: 'star' } // [^/]*    — within one path segment
  | { kind: 'globstar' } // .*       — crosses segment boundaries
  | { kind: 'globslash' }; // (?:.*[/])? — zero or more whole directories

/**
 * Parses a pattern into tokens with the same left-to-right scan the previous
 * RegExp translation used, so a doublestar is recognised before a lone star and
 * a doublestar-slash consumes its trailing `/`.
 */
function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          tokens.push({ kind: 'globslash' });
          i += 2; // consumed second `*` and the `/`
        } else {
          tokens.push({ kind: 'globstar' });
          i += 1; // consumed second `*`
        }
      } else {
        tokens.push({ kind: 'star' });
      }
      continue;
    }
    tokens.push({ kind: 'lit', ch: pattern[i] as string });
  }
  return tokens;
}
