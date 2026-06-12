import test from 'node:test';
import assert from 'node:assert/strict';
import type { FrontMatter } from '../../workflow/src/types.ts';
import {
  CorruptStateError,
  parseFrontMatter,
  serializeFrontMatter,
  parseSubset,
  serializeSubset,
  validateReason,
} from '../../workflow/src/front-matter.ts';

// A complete, schema-valid FrontMatter used as the round-trip seed. The
// serializer is the definition of canonical form, so tests assert stability
// (serialize -> parse -> serialize is fixed-point) rather than hard-coding bytes,
// plus a few format assertions that PIN the chosen canonical shape.
function makeFrontMatter(): FrontMatter {
  return {
    feature: 'dark-mode-toggle',
    branch: 'feature/dark-mode-toggle',
    worktree: '../app-dark-mode-toggle',
    base: 'main',
    base_sha: '9c1f2a',
    cmux_section: 'dark-mode-toggle',
    state: 'plan-inprogress',
    loopback_count: 0,
    loopback_cap: 2,
    claimed_by: 'pane-2:claude',
    updated: '2026-06-10T12:00:00Z',
    phases: {
      plan: {
        last_success_loop: null,
        attempts: 1,
        start_sha: '9c1f2a',
        complete_sha: null,
      },
    },
    budget_spent: { total_seconds: 0 },
  };
}

function expectCorrupt(fn: () => unknown, codeHint?: string): CorruptStateError {
  try {
    fn();
  } catch (e) {
    assert.ok(
      e instanceof CorruptStateError,
      `expected CorruptStateError, got ${String(e)}`,
    );
    assert.equal(
      e.kind,
      'corrupt-state',
      'typed error must carry kind "corrupt-state" for the recover path',
    );
    if (codeHint !== undefined) {
      assert.equal(e.code, codeHint, `expected code "${codeHint}", got "${e.code}"`);
    }
    return e;
  }
  assert.fail('expected a CorruptStateError to be thrown, but nothing threw');
}

test('round-trip-canonical', () => {
  // Minimal FrontMatter (empty phases is OMITTED on the wire; absent on parse).
  const minimal = makeFrontMatter();
  minimal.phases = {};
  const s1 = serializeFrontMatter(minimal);
  const s2 = serializeFrontMatter(parseFrontMatter(s1));
  assert.equal(s2, s1, 'parse(serialize) then serialize must be byte-identical');
  const s3 = serializeFrontMatter(parseFrontMatter(s2));
  assert.equal(s3, s2, 'serialize -> parse -> serialize must be a fixed point');

  // Full FrontMatter exercising every container: phases, forced_actions,
  // optional needs_human_reason, optional auto_advanced.
  const full = makeFrontMatter();
  full.state = 'needs-human';
  full.needs_human_reason = 'loopback-cap';
  full.phases = {
    plan: {
      last_success_loop: 0,
      attempts: 2,
      start_sha: '9c1f2a',
      complete_sha: null,
    },
    'consolidate-plan': {
      last_success_loop: 0,
      attempts: 1,
      start_sha: 'ab12cd',
      complete_sha: 'ab12cd',
      auto_advanced: true,
    },
  };
  full.forced_actions = [
    {
      phase: 'plan',
      loop: 1,
      from_state: 'plan-changes-requested',
      reason: 'manual override after stuck reviewer',
      at: '2026-06-10T13:00:00Z',
      claimed_by: 'pane-2:claude',
    },
  ];
  const f1 = serializeFrontMatter(full);
  const f2 = serializeFrontMatter(parseFrontMatter(f1));
  assert.equal(f2, f1, 'full front matter must round-trip byte-stable');

  // Pin the canonical shape so format choices cannot silently drift.
  assert.ok(f1.startsWith('---\n'), 'opens with a --- fence');
  assert.ok(f1.endsWith('---\n'), 'closes with a --- fence + trailing newline');
  assert.match(f1, /\nstate: "needs-human"\n/, 'strings are double-quoted');
  assert.match(f1, /\nloopback_count: 0\n/, 'ints are bare');
  assert.match(f1, /\nupdated: 2026-06-10T12:00:00Z\n/, 'timestamps are bare');
  assert.match(f1, /\n {4}auto_advanced: true\n/, 'booleans are bare, 2-space indent');
  assert.match(f1, /\n {4}complete_sha: null\n/, 'null is bare');
  assert.match(f1, /\n {2}- phase: "plan"\n/, 'forced_actions is a block sequence');
  // consolidate-plan comes after plan in the canonical phase order.
  assert.ok(
    f1.indexOf('\n  plan:\n') < f1.indexOf('\n  consolidate-plan:\n'),
    'phase keys serialize in transition-table order',
  );
});

test('generic-round-trip-preserves-unrelated-keys', () => {
  // The generic subset layer (reused for STATE.md feature records, Task 12.2)
  // must faithfully round-trip keys it does not recognize.
  const canonical = [
    '---',
    'title: "STATE"',
    'count: 3',
    'active: true',
    'note: null',
    'updated: 2026-06-10T12:00:00Z',
    'nested:',
    '  a: 1',
    '  b: "two"',
    'features:',
    '  - slug: "dark-mode"',
    '    pr: 0',
    '    review_state: "building"',
    '  - slug: "light-mode"',
    '    pr: 7',
    '    review_state: "done"',
    '---',
    '',
  ].join('\n');
  const doc = parseSubset(canonical);
  assert.equal(
    serializeSubset(doc),
    canonical,
    'unrelated keys (title, count, nested, features) must round-trip byte-stable',
  );
  // The keys survive, in order.
  assert.deepEqual(
    doc.entries.map(([k]) => k),
    ['title', 'count', 'active', 'note', 'updated', 'nested', 'features'],
  );
});

test('rejects-outside-subset', () => {
  const wrap = (body: string): string => `---\n${body}\n---\n`;
  const cases: Array<{ name: string; text: string }> = [
    { name: 'anchor', text: wrap('a: &anchor 1') },
    { name: 'alias', text: wrap('a: *anchor') },
    { name: 'flow map', text: wrap('a: {x: 1}') },
    { name: 'flow seq', text: wrap('a: [1, 2]') },
    { name: 'tag', text: wrap('a: !!str hi') },
    { name: 'block scalar |', text: wrap('a: |\n  hello') },
    { name: 'block scalar >', text: wrap('a: >\n  hello') },
    { name: 'bare string', text: wrap('a: bareword') },
    { name: 'boolean yes/no', text: wrap('a: yes') },
    {
      name: 'over-deep nesting',
      text: wrap('a:\n  b:\n    c:\n      d: 1'),
    },
    { name: 'scalar list item', text: wrap('a:\n  - 1') },
    { name: 'extra document marker', text: '---\na: 1\n---\nb: 2\n---\n' },
  ];
  for (const c of cases) {
    expectCorrupt(() => parseSubset(c.text));
  }
  // Spot-check the depth rule produces the dedicated code.
  expectCorrupt(
    () => parseSubset(wrap('a:\n  b:\n    c:\n      d: 1')),
    'nesting-too-deep',
  );
  // Fix B (test gaps): constructs already rejected by code, now pinned.
  // (a) full-line comment.
  expectCorrupt(() => parseSubset(wrap('# foo')), 'comment');
  // (b) inline comment (the value `1 # x` is not a subset scalar).
  expectCorrupt(() => parseSubset(wrap('a: 1 # x')), 'out-of-subset');
  // (c) CRLF line endings and a lone CR are both out of subset.
  expectCorrupt(() => parseSubset('---\r\na: 1\r\n---\r\n'), 'cr-not-allowed');
  expectCorrupt(() => parseSubset('---\na: 1\r---\n'), 'cr-not-allowed');
});

test('rejects-bad-state-value', () => {
  const good = serializeFrontMatter(makeFrontMatter());
  const bad = good.replace('"plan-inprogress"', '"not-a-real-state"');
  assert.notEqual(bad, good, 'fixture replacement must have applied');
  const err = expectCorrupt(() => parseFrontMatter(bad), 'bad-state');
  assert.match(err.message, /not-a-real-state/);
});

test('corrupted-yaml-typed-error', () => {
  // Bad indentation (odd / not parent+2).
  expectCorrupt(() => parseSubset('---\na:\n   b: 1\n---\n'));
  // Missing colon.
  expectCorrupt(() => parseSubset('---\na 1\n---\n'), 'missing-colon');
  // Duplicate key.
  expectCorrupt(() => parseSubset('---\na: 1\na: 2\n---\n'), 'duplicate-key');
  // Tab as indent.
  expectCorrupt(() => parseSubset('---\na:\n\tb: 1\n---\n'));
  // Missing fences entirely.
  expectCorrupt(() => parseSubset('a: 1\n'));
  // A value with nothing after the colon-space is not implicit null.
  expectCorrupt(() => parseSubset('---\na: \n---\n'));
});

test('quoted-string-escaping', () => {
  // Quotes and backslashes survive JSON-style escaping and round-trip exactly.
  const fm = makeFrontMatter();
  const reason = 'He said "hi" and used a back\\slash';
  fm.forced_actions = [
    {
      phase: 'plan',
      loop: 0,
      from_state: 'created',
      reason,
      at: '2026-06-10T13:00:00Z',
      claimed_by: 'pane-2:claude',
    },
  ];
  const text = serializeFrontMatter(fm);
  assert.match(
    text,
    /reason: "He said \\"hi\\" and used a back\\\\slash"/,
    'reason serializes with JSON-style escaping',
  );
  const round = parseFrontMatter(text);
  assert.equal(round.forced_actions?.[0]?.reason, reason, 'reason round-trips exactly');

  // Generic string scalars escape too.
  const doc = parseSubset('---\nk: "a\\"b\\\\c"\n---\n');
  const first = doc.entries[0];
  assert.ok(first && first[1].kind === 'string');
  assert.equal(first[1].value, 'a"b\\c');
  assert.equal(serializeSubset(doc), '---\nk: "a\\"b\\\\c"\n---\n');

  // Reason validation: length cap and control chars are rejected.
  assert.doesNotThrow(() => validateReason('a'.repeat(200)));
  expectCorrupt(() => validateReason('a'.repeat(201)), 'reason-too-long');
  expectCorrupt(() => validateReason('line1\nline2'), 'reason-bad-char');
  expectCorrupt(() => validateReason('tab\there'), 'reason-bad-char');
  expectCorrupt(() => validateReason('non-ascii é'), 'reason-bad-char');

  // A bad reason is rejected on the write path too.
  const badFm = makeFrontMatter();
  badFm.forced_actions = [
    {
      phase: 'plan',
      loop: 0,
      from_state: 'created',
      reason: 'x'.repeat(201),
      at: '2026-06-10T13:00:00Z',
      claimed_by: 'pane-2:claude',
    },
  ];
  expectCorrupt(() => serializeFrontMatter(badFm), 'reason-too-long');
});

test('null-and-timestamp-scalars', () => {
  // Generic layer types null and timestamp distinctly from strings.
  const doc = parseSubset('---\nn: null\nt: 2026-06-10T12:00:00Z\ns: "2026-06-10T12:00:00Z"\n---\n');
  const byKey = new Map(doc.entries);
  assert.equal(byKey.get('n')?.kind, 'null');
  const t = byKey.get('t');
  assert.ok(t && t.kind === 'timestamp');
  assert.equal(t.value, '2026-06-10T12:00:00Z');
  // A quoted timestamp is a STRING, not a timestamp (the quotes decide).
  assert.equal(byKey.get('s')?.kind, 'string');

  // FrontMatter: null phase fields and the timestamp `updated` parse and
  // serialize back canonically (null bare, timestamp bare).
  const fm = makeFrontMatter();
  const parsed = parseFrontMatter(serializeFrontMatter(fm));
  assert.equal(parsed.phases['plan']?.last_success_loop, null);
  assert.equal(parsed.phases['plan']?.complete_sha, null);
  assert.equal(parsed.phases['plan']?.start_sha, '9c1f2a');
  assert.equal(parsed.updated, '2026-06-10T12:00:00Z');
  const out = serializeFrontMatter(parsed);
  assert.match(out, /\n {4}last_success_loop: null\n/);
  assert.match(out, /\nupdated: 2026-06-10T12:00:00Z\n/);
  // A bad ISO timestamp is rejected on read.
  const badTs = serializeFrontMatter(fm).replace(
    'updated: 2026-06-10T12:00:00Z',
    'updated: 2026-13-99T99:99:99Z',
  );
  expectCorrupt(() => parseFrontMatter(badTs));
});

test('rejects-control-chars-in-string-scalars', () => {
  // Fix A (hardening): ANY string scalar (not just `reason`) whose decoded value
  // carries a control char U+0000..U+001F or U+007F is rejected at the generic
  // parse layer — these values feed downstream git/fs ops. Escapes that DECODE
  // to a control char are caught (JSON.parse honors them before the check).
  // Embedded newline (U+000A) via a \n escape in a non-reason field.
  expectCorrupt(
    () => parseSubset('---\nbranch: "feat/x\\ny"\n---\n'),
    'control-char-in-string',
  );
  // DEL (U+007F) via a \u escape.
  expectCorrupt(
    () => parseSubset('---\nfeature: "a\\u007fb"\n---\n'),
    'control-char-in-string',
  );
  // NUL (U+0000).
  expectCorrupt(
    () => parseSubset('---\nclaimed_by: "p\\u0000c"\n---\n'),
    'control-char-in-string',
  );
  // A control-free string scalar still parses (no false positive on the floor).
  assert.doesNotThrow(() => parseSubset('---\nbranch: "feat/x-y"\n---\n'));
});

test('rejects-calendar-invalid-timestamps', () => {
  // Fix C (fidelity): TIMESTAMP_RE shape-matches but JS Date silently rolls a
  // bad day over (Feb 30 -> Mar 2). Reject any literal whose re-derived UTC
  // components do not equal the input fields.
  expectCorrupt(() => parseSubset('---\nt: 2026-02-30T00:00:00Z\n---\n'), 'bad-timestamp');
  expectCorrupt(() => parseSubset('---\nt: 2026-04-31T00:00:00Z\n---\n'), 'bad-timestamp');
  // Non-leap Feb 29 rolls over to Mar 1 -> rejected.
  expectCorrupt(() => parseSubset('---\nt: 2026-02-29T00:00:00Z\n---\n'), 'bad-timestamp');
  // A leap-year Feb 29 is a real instant: types as `timestamp` and round-trips
  // byte-stable through the generic layer.
  const ok = '---\nt: 2024-02-29T12:00:00Z\n---\n';
  const doc = parseSubset(ok);
  const node = doc.entries[0]?.[1];
  assert.ok(node && node.kind === 'timestamp', 'valid timestamp types as timestamp');
  assert.equal(serializeSubset(doc), ok, 'valid timestamp round-trips byte-stable');
});

test('rejects-unknown-and-missing-keys', () => {
  // Unknown top-level key (e.g. the dropped merge_waiver) fails schema validation.
  const withMergeWaiver = serializeFrontMatter(makeFrontMatter()).replace(
    '\nbudget_spent:',
    '\nmerge_waiver: "x"\nbudget_spent:',
  );
  expectCorrupt(() => parseFrontMatter(withMergeWaiver), 'unknown-key');
  // Missing required key.
  const missing = serializeFrontMatter(makeFrontMatter()).replace(
    /\nbase_sha: "9c1f2a"/,
    '',
  );
  expectCorrupt(() => parseFrontMatter(missing), 'missing-key');
});
