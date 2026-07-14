import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capAndRedactBypassReason, BYPASS_REASON_MAX } from '../../runner/src/redact.ts';

/* Every token-shaped fixture is CONSTRUCTED at runtime (never a literal): the
   pilot's full-tier gitleaks scans the vendored core tree, tests included, so a
   committed token literal would trip it. */

test('undefined, empty, and whitespace-only reasons collapse to undefined', () => {
  for (const v of [undefined, '', '   ']) {
    assert.equal(capAndRedactBypassReason(v), undefined, `input=${JSON.stringify(v)}`);
  }
});

test('invisible-only reasons (zero-width) collapse to undefined; embedded ones pass', () => {
  /* U+200B survives String.trim() as a length-1 "non-empty" string — an invisible
     reason would be a hollow audit trail, so it must not enable a bypass. */
  for (const v of ['\u200b', '\u200b\u200b', '\u200b \u200b', '\u2800', '\u3164', '\u2800 \u3164']) {
    assert.equal(capAndRedactBypassReason(v), undefined, `input=${JSON.stringify(v)}`);
  }
  assert.equal(capAndRedactBypassReason('fix\u200bme'), 'fix\u200bme');
});

test('a benign human reason passes through unchanged', () => {
  const benign = 'hotfix: CI flake, companion test lands next commit';
  assert.equal(capAndRedactBypassReason(benign), benign);
});

test('every secret pattern class is redacted', () => {
  /* One representative per deny-list class; each token built so its OWN pattern
     (not the generic 40-run fallback) matches, pinning the specific rule. */
  const tokens = [
    ['ghp', 'a'.repeat(28)].join('_'),
    ['github_pat', '0'.repeat(24)].join('_'),
    ['glpat', '1'.repeat(24)].join('-'),
    ['xoxb', '2'.repeat(16)].join('-'),
    ['sk', 'a'.repeat(24)].join('-'),
    'AKIA' + 'A'.repeat(16),
    ['eyJ' + 'a'.repeat(12), 'eyJ' + 'b'.repeat(12), 'c'.repeat(8)].join('.'),
    /* Body kept UNDER 40 chars so the generic 40-run fallback cannot mask a
       deleted PEM pattern (vacuous-oracle guard, Gate C round 2). */
    '-----BEGIN RSA PRIVATE KEY-----\n' + 'k'.repeat(24) + '\n-----END RSA PRIVATE KEY-----',
    'Bearer ' + ['abcdef', '1234567890', 'abcdef'].join(''),
    'z'.repeat(40),
  ];
  for (const token of tokens) {
    const out = capAndRedactBypassReason(`before ${token} after`) ?? '';
    assert.match(out, /\[REDACTED\]/, `not redacted: ${token.slice(0, 12)}…`);
    assert.ok(!out.includes(token), `raw token survived: ${token.slice(0, 12)}…`);
  }
  /* The PEM rule must consume header AND footer itself — not leave them around
     a generic-redacted body. */
  const pem = '-----BEGIN RSA PRIVATE KEY-----\n' + 'k'.repeat(24) + '\n-----END RSA PRIVATE KEY-----';
  assert.equal(capAndRedactBypassReason(`before ${pem} after`), 'before [REDACTED] after');
});

test('quoted key=value secrets are redacted atomically, both quote styles', () => {
  /* Gate C round 2: \S+ alone stopped at the first space inside a quoted value,
     leaking its tail ("correct horse battery" → only "correct got redacted). */
  const dq = capAndRedactBypassReason('config password="correct horse battery" here') ?? '';
  assert.ok(!dq.includes('horse'), dq);
  const sq = capAndRedactBypassReason("config secret='open sesame now' here") ?? '';
  assert.ok(!sq.includes('sesame'), sq);
});

test('cap never ends on a split surrogate pair', () => {
  const emoji = '😀'; // 2 UTF-16 code units
  const prose = ('ab '.repeat(66) + 'a').slice(0, BYPASS_REASON_MAX - 1); // 199 chars, no 40-run
  const out = capAndRedactBypassReason(prose + emoji) ?? '';
  assert.equal(out.length, BYPASS_REASON_MAX - 1, 'lone high surrogate must be dropped');
  assert.ok(!/[\ud800-\udbff]$/.test(out));
});

test('redact runs BEFORE cap: a token crossing the 200 boundary leaves no fragment', () => {
  /* Gate P F4: cap-first would truncate the token mid-string and leave a prefix
     (e.g. "ghp_a") that is too short for the ghp pattern to re-match → leak.
     Benign 195-char prose keeps the token straddling index 200. A trailing
     partial "[REDA…" marker is acceptable cosmetics — the secret is already gone. */
  const prose = 'word '.repeat(39); // 195 chars, no 40-run, no key=value
  assert.equal(prose.length, 195);
  const token = ['ghp', 'a'.repeat(28)].join('_'); // 32 chars, spans index 195..226
  const out = capAndRedactBypassReason(prose + token) ?? '';
  assert.ok(out.length <= BYPASS_REASON_MAX, `length ${out.length}`);
  assert.ok(!out.includes('ghp_'), 'no token fragment may survive');
  assert.ok(out.includes('word'), 'benign prose must survive');
});

test('cap: benign prose over 200 chars is truncated to exactly 200', () => {
  const long = 'ab '.repeat(120); // 360 benign chars, no redactable run
  const out = capAndRedactBypassReason(long) ?? '';
  assert.equal(out.length, BYPASS_REASON_MAX);
});

test('two secrets on one line are both redacted', () => {
  const t1 = ['ghp', 'a'.repeat(28)].join('_');
  const t2 = 'AKIA' + 'B'.repeat(16);
  const out = capAndRedactBypassReason(`leak one ${t1} and two ${t2} done`) ?? '';
  assert.ok(!out.includes(t1) && !out.includes(t2));
  assert.equal((out.match(/\[REDACTED\]/g) ?? []).length, 2);
});

test('key=value secrets are redacted; a 40-hex SHA is a documented false positive', () => {
  const pw = capAndRedactBypassReason('config password=correct-horse-battery here') ?? '';
  assert.match(pw, /\[REDACTED\]/);
  assert.ok(!pw.includes('correct-horse-battery'));

  const apiKey = capAndRedactBypassReason('using api_key: abc12345 for test') ?? '';
  assert.match(apiKey, /\[REDACTED\]/);
  assert.ok(!apiKey.includes('abc12345'));

  /* Over-redaction bias (D6): a SHA-length hex run trips the generic pattern.
     Accepted — the reason is a human note, not a payload channel. */
  const sha40 = '0123456789abcdef'.repeat(3).slice(0, 40);
  const shaOut = capAndRedactBypassReason(`see commit ${sha40} for context`) ?? '';
  assert.match(shaOut, /\[REDACTED\]/);
  assert.ok(!shaOut.includes(sha40));
});
