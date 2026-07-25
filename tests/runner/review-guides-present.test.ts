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
   a missing file, or a renamed/dropped corpus file all fail here.
   Pin OWNERSHIP mirrors rule ownership (ADR-026): corpus enumeration is
   asserted on each composition, shared contract rules on the core alone, and
   runtime mechanics on each raw adapter — so neither an emptied adapter nor a
   mis-homed shared rule can pass on the other file's text. */

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

/* Each runtime EXECUTES the shared core plus its own adapter; the composition
   is what corpus enumeration is asserted against (contract pins assert on the
   owning file instead — see the header). */
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

test('the shared core exists nonblank and each adapter fail-closes on its read FIRST', () => {
  const core = readFileSync(corePath, 'utf8');
  assert.ok(core.trim().length > 0, `${CORE_SOURCE} must exist and be nonblank`);
  for (const adapter of RUNTIME_ADAPTERS) {
    const adapterPath = fileURLToPath(new URL(`../../agents/skill-sources/${adapter}`, import.meta.url));
    const raw = readFileSync(adapterPath, 'utf8');
    assert.ok(raw.includes(CORE_POINTER), `${adapter} must name the core path ${CORE_POINTER}`);
    /* A stable fail-closed phrase so a rewrite that drops the guard is caught. */
    assert.match(raw, /fail closed/i, `${adapter} must fail closed if the core is unreadable`);
    /* ORDER is part of the contract: the core read is the adapter's first
       executable instruction, so the first section heading must be the
       core-read section — a rewrite that moves setup/dispatch above it fails. */
    const firstSectionHeading = raw.split('\n').find((line) => line.startsWith('## '));
    assert.match(
      firstSectionHeading ?? '',
      /read the shared core/i,
      `${adapter} first section must be the fail-closed core read, found: ${firstSectionHeading}`,
    );
  }
});

test('each runtime composition (core + adapter) enumerates every corpus file by name', () => {
  for (const adapter of RUNTIME_ADAPTERS) {
    const body = composedBody(adapter);
    const missing = templateNames().filter((name) => !body.includes(name));
    assert.deepEqual(missing, [], `${adapter} composition never names corpus files: ${missing.join(', ')}`);
  }
});

/* The resource-redesign contract (ADR-026). Rule OWNERSHIP is part of the
   contract — every shared rule lives in the CORE (a rule surviving only via an
   adapter mention is a mis-homed rule) — so these pins assert on the core file
   ALONE, not the composition. Each pins a known silent-regression boundary:
   tier collapse, discovery-route merge, lost fork-freshness, a full-pipeline
   commit-slice, homogeneous final review without disclosure, partial fan-out,
   a silently dropped per-route COVERAGE/legacy-broadcast rule, or infra
   masquerading as a fix failure. */
const CORE_CONTRACT_PINS = [
  'NOT_TRIGGERED',
  'LIGHT',
  'STANDARD',
  'DEEP',
  'fork:none',
  'one-finding-per-call',
  'cross-runtime-family',
  'not cross-family',
  'Budget fail-fast',
  'infra-blocked',
  'stay differentiated',
  'COVERAGE',
  'broadcast into every TRIGGERED route',
  'non-mutating merge-tree check against the same mainline SHA',
];

test('the core alone pins the shared resource-redesign contract (rule ownership)', () => {
  /* Collapse whitespace so prose line-wrapping never splits a phrase mid-match. */
  const normalizedCore = readFileSync(corePath, 'utf8').replace(/\s+/g, ' ');
  const missing = CORE_CONTRACT_PINS.filter((phrase) => !normalizedCore.includes(phrase));
  assert.deepEqual(missing, [], `core missing contract phrases: ${missing.join(' | ')}`);
  /* The four matrix states must all be named so a dropped-state rewrite is
     caught; NOT_TRIGGERED is the new adaptive-discovery state. */
  for (const matrixState of ['APPLIED', 'SKIPPED', 'GAP', 'NOT_TRIGGERED']) {
    assert.ok(normalizedCore.includes(matrixState), `core coverage-matrix state ${matrixState} missing`);
  }
});

/* Adapter mechanics are pinned on the RAW adapter file (not the composition) so
   an emptied adapter cannot pass on core mentions alone. */
const ADAPTER_CONTRACT_PINS: Record<string, string[]> = {
  'deep-review-refactor.md': [
    'worker-route floor',
    'DEEP_REVIEW_GUARD_OFF',
    'TRIGGERED route',
    'SINGLE-ECOSYSTEM',
  ],
  'deep-review-refactor-codex.md': [
    'Use Codex workers exclusively',
    'Default to `review-and-refactor`',
    'Keep the main session as a thin orchestrator',
    /* The conflict preflight lives in core; the adapter binds the exclusive
       conflict worker to Codex. */
    'dispatch exactly one fresh, separate Codex worker dedicated only to conflict resolution',
  ],
};

test('each raw adapter pins its own runtime mechanics', () => {
  for (const adapter of RUNTIME_ADAPTERS) {
    const adapterPath = fileURLToPath(new URL(`../../agents/skill-sources/${adapter}`, import.meta.url));
    const normalizedAdapter = readFileSync(adapterPath, 'utf8').replace(/\s+/g, ' ');
    const missing = ADAPTER_CONTRACT_PINS[adapter].filter((phrase) => !normalizedAdapter.includes(phrase));
    assert.deepEqual(missing, [], `${adapter} missing runtime-mechanic phrases: ${missing.join(' | ')}`);
  }
});
