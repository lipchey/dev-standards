// Manifest glob dialect: * stays within one segment; ** crosses segments but ONLY as a whole
// segment (an embedded a**b is within-segment stars, matching tools/*.mjs); doublestar-slash may
// match zero directories. Bottom-up DP avoids RegExp backtracking on adjacent doublestars.
export function matches(path: string, pattern: string): boolean {
  const tokens = tokenize(pattern);
  const n = path.length;
  const m = tokens.length;

  // next is column j+1; cur is column j. The base column matches only path end.
  let next = new Uint8Array(n + 1);
  next[n] = 1;

  for (let j = m - 1; j >= 0; j -= 1) {
    const token = tokens[j] as Token;
    const cur = new Uint8Array(n + 1);
    // For **/, carry the non-empty branch while scanning backward.
    let taken = false;
    for (let i = n; i >= 0; i -= 1) {
      const ch = path[i];
      let ok = false;
      switch (token.kind) {
        case 'lit':
          ok = i < n && ch === token.ch && next[i + 1] === 1;
          break;
        case 'star':
          ok = next[i] === 1 || (i < n && ch !== '/' && cur[i + 1] === 1);
          break;
        case 'globstar':
          ok = next[i] === 1 || (i < n && cur[i + 1] === 1);
          break;
        case 'globslash': {
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

/* The literal directory a pattern is rooted in, '' being the repo root; scanning to the first `*`
   suffices because the dialect has no other wildcard. */
export function literalPrefixDir(pattern: string): string {
  const firstStar = pattern.indexOf('*');
  const head = firstStar === -1 ? pattern : pattern.slice(0, firstStar);
  const lastSlash = head.lastIndexOf('/');
  return lastSlash === -1 ? '' : head.slice(0, lastSlash);
}

type Token =
  | { kind: 'lit'; ch: string }
  | { kind: 'star' }
  | { kind: 'globstar' }
  | { kind: 'globslash' };

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '*') {
      // A `**` is a globstar (crosses `/`) ONLY as a WHOLE path segment: preceded by start-or-`/`
      // and followed by `/`-or-end. Anywhere else (a**b, src**.ts) the two stars are ordinary
      // within-segment wildcards that never cross `/`, matching tools/*.mjs which split on `/`
      // first (BUG-09). The validator rejects embedded `**`, so aligned matchers only need to
      // agree on it for conformance.
      const atSegmentStart = i === 0 || pattern[i - 1] === '/';
      if (pattern[i + 1] === '*' && atSegmentStart) {
        if (pattern[i + 2] === '/') {
          tokens.push({ kind: 'globslash' });
          i += 2;
          continue;
        }
        if (i + 2 === pattern.length) {
          tokens.push({ kind: 'globstar' });
          i += 1;
          continue;
        }
      }
      // A lone `*`, or one star of an embedded double-star: a single within-segment wildcard.
      tokens.push({ kind: 'star' });
      continue;
    }
    tokens.push({ kind: 'lit', ch: pattern[i] as string });
  }
  return tokens;
}
