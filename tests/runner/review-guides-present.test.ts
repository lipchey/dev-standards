import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* INT-06 integrity guard, strengthened in the guides revamp (Gate-P F5),
   re-keyed to the profile corpus (ADR-018 rewrite), then re-keyed again to the
   core/adapter split (deep-review-core extraction): the two runtime bodies no
   longer carry the process rules directly — each ADAPTER reads a shared
   runtime-agnostic core and adds only its runtime mechanics, so every rule is
   executed as the COMPOSITION core + adapter. This test therefore asserts the
   pinned contract against that composition, from two independent directions:
   1. catalog provenance: the corpus names must equal the set the skill-catalog
      `feeds_guides` arrays reference (unchanged by the split);
   2. skill consumption: for each runtime, the core + adapter composition must
      enumerate all nine corpus files and keep every currently pinned contract
      phrase, and each adapter must fail closed on the core read.
   A corpus file added without catalog provenance, a catalog entry pointing at
   a missing file, or a renamed/dropped corpus file all fail here. */

const templatesDir = fileURLToPath(new URL('../../agents/review-guide-templates/', import.meta.url));
const catalogPath = fileURLToPath(new URL('../../agents/skill-catalog.json', import.meta.url));

/* The shared, runtime-agnostic process body both adapters read first. */
const CORE_SOURCE = 'deep-review-core.md';
const CORE_POINTER = 'agents/skill-sources/deep-review-core.md';
const corePath = fileURLToPath(new URL(`../../agents/skill-sources/${CORE_SOURCE}`, import.meta.url));

/* The two runtime adapters; each executes core + itself. */
const RUNTIME_ADAPTERS = ['deep-review-refactor.md', 'deep-review-refactor-codex.md'];

/* The corpus names the profile fan-out consumes, by contract: the shared worker
   contract plus the eight lens profiles. */
const CORPUS_ROLES = [
  'review-contract.md',
  'profile-architecture-and-boundaries.md',
  'profile-naming-and-constants.md',
  'profile-tests-quality.md',
  'profile-types-and-contracts.md',
  'profile-correctness-and-lifecycle.md',
  'profile-module-depth.md',
  'profile-refactoring-and-smells.md',
  'profile-security.md',
];

function catalogGuides(): string[] {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
    sources: { feeds_guides?: string[] }[];
  };
  const fromCatalog = catalog.sources.flatMap((s) => s.feeds_guides ?? []);
  return [...new Set(fromCatalog)].sort();
}

function templateNames(): string[] {
  // TRACEABILITY.md is the loader-excluded registry, not corpus (guides.ts).
  return readdirSync(templatesDir)
    .filter((n) => n.endsWith('.md') && n !== 'TRACEABILITY.md')
    .sort();
}

/* Each runtime EXECUTES the shared core plus its own adapter, so every pinned
   contract phrase is asserted against that composition, never a single file. */
function composedBody(adapterSource: string): string {
  const adapterPath = fileURLToPath(new URL(`../../agents/skill-sources/${adapterSource}`, import.meta.url));
  return `${readFileSync(corePath, 'utf8')}\n${readFileSync(adapterPath, 'utf8')}`;
}

test('template dir and catalog provenance agree exactly (set equality)', () => {
  assert.deepEqual(
    templateNames(),
    catalogGuides(),
    'agents/review-guide-templates/*.md minus TRACEABILITY.md must equal union(feeds_guides)',
  );
});

test('the skill corpus list equals the template dir exactly (no orphan in either direction)', () => {
  assert.deepEqual(
    [...CORPUS_ROLES].sort(),
    templateNames(),
    'CORPUS_ROLES must equal the corpus set — a renamed/added corpus file must update the skill contract',
  );
});

test('the shared core exists nonblank and each adapter fail-closes on its read', () => {
  const core = readFileSync(corePath, 'utf8');
  assert.ok(core.trim().length > 0, `${CORE_SOURCE} must exist and be nonblank`);
  for (const adapter of RUNTIME_ADAPTERS) {
    const adapterPath = fileURLToPath(new URL(`../../agents/skill-sources/${adapter}`, import.meta.url));
    const raw = readFileSync(adapterPath, 'utf8');
    assert.ok(raw.includes(CORE_POINTER), `${adapter} must name the core path ${CORE_POINTER}`);
    /* A stable fail-closed phrase so a rewrite that drops the guard is caught. */
    assert.match(raw, /fail closed/i, `${adapter} must fail closed if the core is unreadable`);
  }
});

test('each runtime composition (core + adapter) enumerates every corpus file by name', () => {
  for (const adapter of RUNTIME_ADAPTERS) {
    const body = composedBody(adapter);
    const missing = templateNames().filter((name) => !body.includes(name));
    assert.deepEqual(missing, [], `${adapter} composition never names corpus files: ${missing.join(', ')}`);
  }
});

/* The resource-redesign contract (ADR-026), pinned on BOTH compositions because
   every phrase is a core rule read by each runtime. Each pins a known
   silent-regression boundary: tier collapse, discovery-route merge, lost
   fork-freshness, a full-pipeline commit-slice, homogeneous final review,
   partial fan-out, or infra masquerading as a fix failure. */
const SHARED_CONTRACT_PINS = [
  'NOT_TRIGGERED',
  'LIGHT',
  'STANDARD',
  'DEEP',
  'fork:none',
  'one-finding-per-call',
  'cross-runtime-family',
  'Budget fail-fast',
  'infra-blocked',
  'stay differentiated',
];

test('each runtime composition pins the shared resource-redesign contract', () => {
  for (const adapter of RUNTIME_ADAPTERS) {
    const normalizedBody = composedBody(adapter).replace(/\s+/g, ' ');
    const missing = SHARED_CONTRACT_PINS.filter((phrase) => !normalizedBody.includes(phrase));
    assert.deepEqual(missing, [], `${adapter} composition missing contract phrases: ${missing.join(' | ')}`);
    /* The four matrix states must all be named so a dropped-state rewrite is
       caught; NOT_TRIGGERED is the new adaptive-discovery state. */
    for (const matrixState of ['APPLIED', 'SKIPPED', 'GAP', 'NOT_TRIGGERED']) {
      assert.ok(normalizedBody.includes(matrixState), `${adapter} coverage-matrix state ${matrixState} missing`);
    }
  }
});

test('the Claude composition keeps its worker-route floor and transcript-gate markers', () => {
  const normalizedBody = composedBody('deep-review-refactor.md').replace(/\s+/g, ' ');
  const requiredPhrases = ['worker-route floor', 'DEEP_REVIEW_GUARD_OFF', 'TRIGGERED route'];
  const missing = requiredPhrases.filter((phrase) => !normalizedBody.includes(phrase));
  assert.deepEqual(missing, [], `Claude markers missing: ${missing.join(' | ')}`);
});

test('the Codex composition pins Codex-only staffing and the conflict-preflight exclusive worker', () => {
  /* Collapse whitespace so prose line-wrapping never splits a phrase mid-match. */
  const normalizedBody = composedBody('deep-review-refactor-codex.md').replace(/\s+/g, ' ');
  const requiredPhrases = [
    'Use Codex workers exclusively',
    'Default to `review-and-refactor`',
    'Keep the main session as a thin orchestrator',
    /* The conflict preflight now lives in core; the adapter binds the exclusive
       conflict worker to Codex and the core carries the same-SHA re-check. */
    'dispatch exactly one fresh, separate Codex worker dedicated only to conflict resolution',
    'non-mutating merge-tree check against the same mainline SHA',
  ];
  const missing = requiredPhrases.filter((phrase) => !normalizedBody.includes(phrase));
  assert.deepEqual(missing, [], `Codex contract phrases missing: ${missing.join(' | ')}`);
});
