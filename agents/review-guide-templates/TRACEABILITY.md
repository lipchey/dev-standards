# Corpus Rewrite Traceability

This table is the migration proof for the seven old guide templates. Every old
normative section, judgment prompt, shape rule, conditionality rule, and output
obligation has one primary destination below. A listed cross-reference is
secondary and never substitutes for the primary full rule.

Scope narrowed 2026-07-15: the worker corpus now covers js/ts/node/react only;
removed targets below point to git history.

Split 2026-07-15 (owner decision): `profile-structure-and-dependencies.md` became
three mandate-specific profiles for worker size and attention parity.

## `core-code-guidelines.md`

| Old section / rule | Primary new home |
| --- | --- |
| Header: repo-owned baseline, review-only judgment prompts, no upstream adaptation | `profile-naming-and-constants.md` introduction; baseline shares in the five non-security owners that carry them; review-only contract in `review-contract.md` §Worker obligation |
| Header: package body stays active and consumer overlay is additive | `review-contract.md` §Worker obligation, untrusted checklist data / guides only ADD checks |
| How to apply: full strength on production paths | `profile-correctness-and-lifecycle.md` §Conditionality; `profile-naming-and-constants.md` §Conditionality; `profile-tests-quality.md` §Conditionality |
| How to apply: lighter one-off scripts/glue while correctness/safety remain | same three conditionality sections; type/structure surface weighting in their conditionality sections |
| How to apply: baseline is short; SOLID/depth/security belong to deep guides | corpus split itself; explicit owner cross-references in every profile |
| Correctness: stated behavior and no scope creep | `profile-correctness-and-lifecycle.md` §Correctness, bullet 1 |
| Correctness: empty/boundary cases | `profile-correctness-and-lifecycle.md` §Correctness, bullet 2 |
| Correctness: branch reachability, inversion, off-by-one, non-happy path | `profile-correctness-and-lifecycle.md` §Correctness, bullet 3 |
| Correctness: async ordering/race/missing await/stale check | `profile-correctness-and-lifecycle.md` §Correctness, bullet 4 |
| Boundaries: external input validation; deep validation delegated to security | `profile-security.md` §Input validation at trust boundaries; correctness cross-reference in §Boundary ownership |
| Boundaries: public types/nullability/pre/postconditions | `profile-types-and-contracts.md` §Public contracts and optional values |
| Boundaries: module boundary leaks internals | `profile-architecture-and-boundaries.md` §Baseline structural checks |
| Error handling: fallible operation, swallowed/logged/broad catch | `profile-correctness-and-lifecycle.md` §Error handling, bullet 1 |
| Error handling: fail safe, partial state, resource leak, fail closed | `profile-correctness-and-lifecycle.md` §Error handling, bullet 2; security-specific form cross-referenced |
| Error handling: actionable errors without secret/PII/path leak | `profile-correctness-and-lifecycle.md` §Error handling, bullet 3; attack impact in `profile-security.md` §Secrets |
| Error handling: only ENOENT means absent | `profile-correctness-and-lifecycle.md` §Error handling, bullet 4; confinement form in `profile-security.md` §Path confinement |
| Naming: ubiquitous-language name and misleading examples | `profile-naming-and-constants.md` §Naming and readability, bullet 1 |
| Naming: intent obvious or non-trivial why-comment | `profile-naming-and-constants.md` §Naming and readability, bullet 2 |
| Naming: duplication versus needless indirection | `profile-architecture-and-boundaries.md` §Baseline structural checks, bullet 2; naming cross-reference |
| Constants placement: conditional constants home, gate-owned narrow case, uncovered literal sites, judgment/exceptions, new home/reuse | `profile-naming-and-constants.md` §Constants placement and reuse (all bullets) |
| Types placement: conditional types home and React props exception; strict typing delegated | `profile-types-and-contracts.md` §Type placement and reuse |
| Comments: non-derivable why/constraint/gotcha/trade-off; forbidden boilerplate | `profile-naming-and-constants.md` §Comments, bullet 1 |
| Comments: file-header constraint/delete test and allowed state markers | `profile-naming-and-constants.md` §Comments, bullet 2 |
| Comments: English only | `profile-naming-and-constants.md` §Comments, bullet 3 |
| Comments: block form plus directive/language exceptions | `profile-naming-and-constants.md` §Comments, bullet 4 |
| Tests: changed behavior has regression-catching test | `profile-tests-quality.md` §Behavioral value and oracle strength, bullet 1 |
| Tests: observable behavior, not implementation; mock sequence anti-pattern | same section, bullet 2 |
| Tests: independent oracle, tautology, mutation signal | same section, bullet 3 |
| Tests: property-based invariant is optional complement, never dependency mandate | same section, bullet 4 |
| Tests: primary failure/edge case | same section, bullet 5 |
| Tests: bug fix regression test red-before/green-after; missing is P2 | same section, bullet 6 |
| Tests: do not retest compiler/linter/vendor/trivial/schema facts | same section, bullet 7 |
| Tests: fewer/deeper and justified large snapshots | same section, bullet 8 |
| Tests: characterization before refactor; structure-coupled test; mutation proof before deletion | same section, bullet 9 |
| Output expectations: finding shape, priorities, evidence, fix, explicit clean | `review-contract.md` §§The finding format, Priority ladder, Evidence standards, The no-findings case; each profile §Output |

## `review-output-format.md`

| Old section / rule | Primary new home |
| --- | --- |
| Header provenance: `awesome-skills/code-review-skill` MIT `f2fd4e57` | `review-contract.md` introduction |
| Header: spec-vs-code completeness is own material | `review-contract.md` introduction |
| Header: shape-only guide, not review criterion; package/overlay behavior | `review-contract.md` introduction and §Worker obligation |
| Template-Version 2 | absorbed contract content; provenance recorded in `c2-draft-notes.md` |
| Finding format: labeled block, stable line 1, no prose wrapping | `review-contract.md` §The finding format |
| Finding example | same section, first code block |
| Priority field and good/bad forms | same section, Priority field |
| Location field, range and area grammar, good/bad forms | same section, Location field |
| Claim field and good/bad forms | same section, Claim field |
| Evidence field and good/bad forms | same section, Evidence field |
| Impact/Risk field and good/bad forms | same section, Impact/Risk field |
| Fix field, PLAN form, good/bad forms | same section, Fix field |
| Full short-review example and verdict | same section, second code block |
| P1 definition and blocking effect | `review-contract.md` §Priority ladder |
| P2 definition and approval rationale | same section |
| P3 definition and no inflation | same section |
| Ambiguous priority chooses lower severity and explains | same section, closing paragraph |
| Calibration table, all 16 example rows | `review-contract.md` §Calibration table, all rows |
| Evidence: failure case | `review-contract.md` §Evidence standards, bullet 1 |
| Evidence: named violated rule/guide | same section, bullet 2 (renamed to profile without semantic change) |
| Evidence: broken invariant | same section, bullet 3 |
| Evidence: repro or failing/absent test | same section, bullet 4 |
| Impact/Risk concrete blast radius and likelihood; tier needs evidence | same section, following paragraphs |
| Rejected evidence/vibes/authority | same section, final paragraph |
| Verdict: exactly one, artifact is untrusted DATA | `review-contract.md` §Verdict discipline |
| Approve definition | same section, Approve bullet |
| Request-changes definition and one-line loopback | same section, Request changes bullet |
| Phase skill owns post-verdict action | same section, closing paragraph |
| No-findings: explicit scoped clean claim | `review-contract.md` §The no-findings case, bullet 1; strengthened per-file in §Coverage and clean claims |
| No-findings: no manufactured P3 | same section, bullet 2 |
| No-findings: name unreviewed scope | same section, bullet 3; `NOT REVIEWED` in §Coverage and clean claims |
| Spec-vs-code conditionality | `review-contract.md` §Spec-vs-code completeness heading/introduction |
| Requirement statuses: implemented/partial/missing/diverged | same section, full table |
| Coverage shape: scope creep as finding | same section, bullet 1 |
| Coverage shape: gaps risk-ordered | same section, bullet 2 |
| Every gap standard finding; table is index | same section, closing paragraph |
| Ordering: severity then file | `review-contract.md` §Ordering and hygiene, bullet 1 |
| Do not duplicate deterministic gates | same section, bullet 2 |
| Do not paste untrusted artifact text as reviewer claim | same section, bullet 3 |
| Machine consumption: stable prefix and two grammars | `review-contract.md` §Machine-consumption note, introduction and grammar bullets |
| Machine consumption: range lifts start; area maps line 1 and retains area | same section, closing paragraph |
| Machine consumption: exact prefix and labeled continuation lines; malformed findings do not lift | same section, closing paragraph |

## `clean-architecture.md`

| Old section / rule | Primary new home |
| --- | --- |
| Header provenance: all three MIT sources and paraphrase note | `profile-architecture-and-boundaries.md` introduction; carried also to tests/types/naming recipients |
| Header Template-Version 2 | all four recipient profile headers |
| Header: deep-review reads package body in place; same-named consumer overlay is additive | `review-contract.md` introduction and §Worker obligation |
| Header: review-only prompts, architecture long tail above baseline | profile introductions and explicit cross-references |
| Conditionality: declared DAG rather than textbook | `profile-architecture-and-boundaries.md` §Clean-architecture conditionality banner |
| Conditionality: strong class-heavy TS | same section, strong bullet; relevant weighting repeated in types/tests |
| Conditionality: light script pipeline, no single-caller interface | same section, light bullet |
| Conditionality: none Bash/n8n | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Conditionality: forcing structure means n/a, not finding | same section, closing paragraph |
| Dependency rule: imports point inward and import inspection | `profile-architecture-and-boundaries.md` §The dependency rule and boundary shape, bullet 1 |
| Dependency rule: data crosses in inner shape | same section, bullet 2; type share cross-referenced |
| Dependency rule: no cycles, name edge to invert, defer to gate | same section, bullet 3 |
| Dependency rule: actual graph versus project-facts DAG | same section, bullet 4 |
| Ports: core owns interface | `profile-architecture-and-boundaries.md` §Ports and adapters, bullet 1 |
| Ports: swappable real/in-memory boundary | same section, bullet 2 |
| Ports: composition root only | same section, bullet 3 |
| Ports: one-adapter-forever caution and real seam threshold | same section, bullet 4 |
| Ports: adapters do not call adapters; legal flows | same section, bullet 5 |
| Layers: entities hold rules and do zero I/O | `profile-architecture-and-boundaries.md` §Layer separation, bullet 1 |
| Layers: use cases orchestrate without transport/persistence | same section, bullet 2 |
| Layers: adapters translate, no business decisions | same section, bullet 3 |
| Layers: domain and transport types separate | `profile-types-and-contracts.md` §Layer-boundary data contracts, bullet 1 |
| Layers: mapping at boundary once | same section, bullet 2 |
| SOLID conditionality and real-pain filter | `profile-architecture-and-boundaries.md` §SOLID introduction; types profile §Substitutability introduction |
| SRP smell/check/when-not/remedy | `profile-architecture-and-boundaries.md` §SRP, all bullets |
| OCP smell/check/when-not/remedy | same file §OCP, all bullets |
| LSP smell/check/when-not/remedy | `profile-types-and-contracts.md` §LSP, all bullets |
| ISP smell/check/when-not/remedy | `profile-types-and-contracts.md` §ISP, all bullets |
| DIP smell/check/when-not/remedy | `profile-architecture-and-boundaries.md` §DIP, all bullets |
| Value object: wrap constrained primitives | `profile-types-and-contracts.md` §Value objects and domain primitives, bullet 1 |
| Value object: immutable and value equality | same section, bullet 2 |
| Value object: no ceremony without invariant | same section, bullet 3 |
| Entity identity equality | same section, bullet 4 |
| DDD: no context internal reach-in | `profile-architecture-and-boundaries.md` §DDD boundaries, bullet 1 |
| DDD: ubiquitous language versus project-facts | `profile-naming-and-constants.md` §Ubiquitous language across boundaries |
| DDD: explicit cross-boundary contract, no shared mutable state | `profile-architecture-and-boundaries.md` §DDD boundaries, bullet 3 |
| Framework: types/annotations stay at edge | `profile-architecture-and-boundaries.md` §Framework isolation, bullet 1 |
| Framework: framework calls inward | same section, bullet 2 |
| Boundary tests conditionality and generic-test cross-reference | `profile-tests-quality.md` §Behavior-first tests at boundaries introduction |
| Boundary tests: use cases through port with fakes | same section, bullet 1 |
| Boundary tests: shared contract suite every adapter | same section, bullet 2 |
| Boundary tests: critical behavior at port, not only E2E | same section, bullet 3 |
| Output: location/area | `review-contract.md` §The finding format; architecture profile §Output |
| Output: triggering prompt | `profile-architecture-and-boundaries.md` §Output |
| Output: conditionality tier and reason | same section |
| Output: risk defaults P2/P1/P3 | same section plus `review-contract.md` §Priority ladder |
| Output: smallest behavior-preserving slice | same section |
| Output: multi-site redesign PLAN; explicit n/a for script/glue | same section |

## `architecture-deepening.md`

| Old section / rule | Primary new home |
| --- | --- |
| Header provenance: `mattpocock/skills`, Ousterhout ideas, `ramziddin/solid-skills`, paraphrase status | `profile-module-depth.md` introduction |
| Header Template-Version 2 | `profile-module-depth.md` header |
| Header: deep-review reads package body in place; same-named consumer overlay is additive | `review-contract.md` introduction and §Worker obligation |
| Header: review-only module-depth long tail and cross-reference ownership | module-depth profile introduction and owner cross-references |
| Conditionality: depth scales with callers/lifetime | `profile-module-depth.md` §Architecture-deepening conditionality banner |
| Conditionality: strong shared/public/library boundary | same section, strong bullet |
| Conditionality: light scripts/pipelines | same section, light bullet |
| Conditionality: none Bash/n8n | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Conditionality: smallest high-friction removal; no soon-deleted-script redesign; n/a is not finding | same section, closing paragraph |
| Vocabulary: module and full interface | `profile-module-depth.md` §Depth vocabulary, bullet 1 |
| Vocabulary: depth/deep/shallow | same section, bullet 2 |
| Vocabulary: leverage | same section, bullet 3 |
| Vocabulary: seam and one-versus-two | same section, bullet 4 |
| Vocabulary: locality | same section, bullet 5 |
| Deep modules: measure caller-knowledge versus hidden behavior | `profile-module-depth.md` §Deep versus shallow modules, bullet 1 |
| Deep modules: interface-to-implementation ratio | same section, bullet 2 |
| Deep modules: pass-through method/wrapper/param | same section, bullet 3 |
| Deep modules: thin manager/anemic wrapper | same section, bullet 4 |
| Deep modules: merge candidates and PLAN | same section, bullet 5 |
| Deep modules: classitis | same section, bullet 6 |
| Deep modules: adjacent layers expose same abstraction | same section, bullet 7 |
| Deletion: delete-and-inline thought experiment | `profile-module-depth.md` §The deletion test, bullet 1 |
| Deletion: one versus two adapters | same section, bullet 2 |
| Deletion: whole pass-through layer and PLAN | same section, bullet 3 |
| Hiding: decision known to many modules and change fan-out | `profile-module-depth.md` §Information hiding and leakage, bullet 1 |
| Hiding: temporal decomposition | same section, bullet 2 |
| Hiding: config sprawl | same section, bullet 3 |
| Hiding: public implementation detail | same section, bullet 4 |
| Hiding: hidden global input | same section, bullet 5 |
| Locality: behavior reads close | `profile-module-depth.md` §Locality of behavior, bullet 1 |
| Locality: wiring/config near behavior | same section, bullet 2 |
| Locality: no partial dogma splitting | same section, bullet 3 |
| Locality: conjoined methods | same section, bullet 4 |
| Pull down: absorb repeated caller complexity | `profile-module-depth.md` §Pull complexity downward and define errors out of existence, bullet 1 |
| Pull down: define unactionable/impossible errors away | same section, bullet 2 |
| Pull down: special cases duplicated at callers | same section, bullet 3 |
| Pull down: configuration overload/defaults | same section, bullet 4 |
| Generality: somewhat-general, not hypothetical; over-special converse | `profile-module-depth.md` §Generality and premature abstraction, bullet 1 |
| Generality: Rule of Three | same section, bullet 2 |
| Complexity symptom: change amplification | `profile-module-depth.md` §The three complexity symptoms, row 1 |
| Complexity symptom: cognitive load | same section, row 2 |
| Complexity symptom: unknown-unknowns | same section, row 3 |
| Leverage: rank by callers/work unblocked | `profile-module-depth.md` §Leverage ranking, bullet 1 |
| Leverage: smallest slice and PLAN | same section, bullet 2 |
| Leverage: essential versus accidental complexity | same section, bullet 3 |
| Candidate strength: concentrate-versus-move filter | `profile-module-depth.md` §Candidate strength, bullet 1 |
| Candidate grade: Strong | same section, table row 1 |
| Candidate grade: Worth exploring | same section, table row 2 |
| Candidate grade: Speculative is not finding | same section, table row 3 |
| Output: location/area and triggering prompt | `review-contract.md` §The finding format; module-depth profile §Output |
| Output: conditionality tier | module-depth profile §Output |
| Output: candidate strength and speculative exclusion | module-depth profile §Output and §Candidate strength |
| Output: leverage/risk and normal priority range | module-depth profile §Output; `review-contract.md` §Priority ladder |
| Output: smallest behavior-preserving slice | module-depth profile §Output |
| Output: leverage ordering, PLAN for many sites, explicit clean | module-depth profile §Output |

## `refactoring-checklist.md`

| Old section / rule | Primary new home |
| --- | --- |
| Header provenance: `ramziddin/solid-skills` MIT `b113ce68`; own tech-debt/execution-order material | `profile-refactoring-and-smells.md` introduction; provenance carried to tests/correctness recipients |
| Header Template-Version 2 | all three recipient profile headers |
| Header: deep-review reads package body in place; same-named consumer overlay is additive | `review-contract.md` introduction and §Worker obligation |
| Header: review-only prompts and fix-mode discipline | `review-contract.md` §Worker obligation; relevant profile sections |
| Header: structural long tail and cross-guide ownership | refactoring profile introduction and owner cross-references |
| Conditionality: strongest real callers/tests | `profile-refactoring-and-smells.md` §Refactoring conditionality banner, bullet 1; tests profile §Conditionality |
| Conditionality: lighter script glue/no manufactured seams | same section, bullet 2 |
| Conditionality: risky refactor is "leave it" with reason | same section, bullet 3 |
| Behavior: behavior/contract tests unchanged, structural-test exception with evidence | `profile-correctness-and-lifecycle.md` §Behavior preservation during refactors, bullet 1 |
| Behavior: preserve outputs/effects/errors/logs on every path | same section, bullet 2 |
| Behavior: reject ride-along behavior changes | same section, bullet 3 |
| Test-cover: behavior test before move | `profile-tests-quality.md` §Test-cover before a refactor, bullet 1 |
| Test-cover: quirky legacy behavior pinned exactly | same section, bullet 2 |
| Test-cover: coverage-free move is P2 risk | same section, bullet 3 |
| Atomic: independently verifiable green slices | `profile-refactoring-and-smells.md` §Small atomic refactor steps, bullet 1 |
| Atomic: each slice independently revertible | same section, bullet 2 |
| Atomic: every slice backed by finding | same section, bullet 3 |
| Atomic: pinning test tooth demonstrated by temporary mutation | `profile-tests-quality.md` §Test-cover before a refactor, bullet 4 |
| Complexity: essential versus accidental before flagging | `profile-refactoring-and-smells.md` §Accidental versus essential complexity, bullet 1 |
| Complexity: change amplification signal and missing home | same section, bullet 2 |
| Complexity: cognitive-load signal, not naming nit | same section, bullet 3 |
| Complexity: do not replace duplication with wrong abstraction | same section, bullet 4 |
| Smell taxonomy: indicator not bug, exceptions/remedy/priority, thresholds not findings, P1 only live defect | `profile-refactoring-and-smells.md` §Code-smells taxonomy introduction |
| Bloater: Long function | same section §Bloaters, row 1 |
| Bloater: Large class | same section §Bloaters, row 2 |
| Bloater: Long parameter list | same section §Bloaters, row 3 |
| Bloater: Data clumps | same section §Bloaters, row 4 |
| Bloater: Primitive obsession | same section §Bloaters, row 5; full invariant rule cross-referenced to types profile |
| OO abuser: Switch on type | same section §Object-orientation abusers, row 1 |
| OO abuser: Refused bequest | same section, row 2; full contract rule cross-referenced to types profile |
| OO abuser: Temporary field | same section, row 3 |
| Change preventer: Divergent change | same section §Change preventers, row 1 |
| Change preventer: Shotgun surgery | same section, row 2 |
| Change preventer: Parallel inheritance | same section, row 3 |
| Dispensable: Dead code and gate exception | same section §Dispensables, row 1 |
| Dispensable: Speculative generality | same section, row 2 |
| Dispensable: Lazy class | same section, row 3 |
| Dispensable: Comments-as-deodorant and KEEP exception | same section, row 4; full comment rule cross-referenced to naming profile |
| Coupler: Feature envy | same section §Couplers, row 1 |
| Coupler: Inappropriate intimacy | same section, row 2 |
| Coupler: Message chains | same section, row 3 |
| Coupler: Middle man | same section, row 4 |
| Seam: hard-wired external dependency blocks unit testing | `profile-refactoring-and-smells.md` §Seams and dependency injection, bullet 1 |
| Seam: reject indirection-only seam via deletion test | same section, bullet 2 |
| Seam: default-wire existing behavior | same section, bullet 3 |
| Dead/duplication: prefer deletion, defer to deterministic gate | `profile-refactoring-and-smells.md` §Duplication, dead code, and speculative flexibility, bullet 1 |
| Dead/duplication: Rule of Three with first/second/third behavior | same section, bullet 2 |
| Dead/duplication: unused flexibility P3 deletion candidate | same section, bullet 3 |
| Debt: defect versus debt classification and evidence | `profile-refactoring-and-smells.md` §Tech-debt classification introduction |
| Debt quadrant: prudent deliberate | same section §Quadrant, row 1 prudent cell |
| Debt quadrant: reckless deliberate | same section §Quadrant, row 1 reckless cell |
| Debt quadrant: prudent inadvertent | same section §Quadrant, row 2 prudent cell |
| Debt quadrant: reckless inadvertent | same section §Quadrant, row 2 reckless cell |
| Debt: interest/principal definitions and priority formula | same section §Interest versus principal |
| Debt: do not pay deletion-bound/stable debt; Boy-Scout condition | same section §Debt worth not paying |
| Execution order: pin first | `profile-refactoring-and-smells.md` §Refactor execution order, step 1 |
| Execution order: introduce additively | same section, step 2 |
| Execution order: migrate callers one at a time | same section, step 3 |
| Execution order: delete old last | same section, step 4 |
| Execution order: low-risk/high-value first and no behavior fold-in | same section, step 5 |
| Execution order: each step committable/revertible/green; re-slice or PLAN | same section, closing paragraph |
| Output: standard fields, smell evidence, regression cost/likelihood, atomic slice and preserving test | `review-contract.md` §The finding format; refactoring profile §Output |
| Output: redesign/many sites is PLAN; explicit clean, no P3 noise | refactoring profile §Output; `review-contract.md` §The no-findings case |

## `security-review.md`

| Old section / rule | Primary new home |
| --- | --- |
| Header Template-Version 2 | `profile-security.md` header |
| Header: package/overlay, conditional skill, review-only, no security laziness | `profile-security.md` introduction; additive overlay contract in `review-contract.md` §Worker obligation |
| Header provenance: OWASP/languages sources, report-discipline ideas, own battle-tested prompts | `profile-security.md` introduction, preserved in full |
| Conditionality: CLI/runner boundary and no auth surface | `profile-security.md` §How to apply, bullet 1 |
| Conditionality: service/web emphasis | same section, bullet 2 |
| Conditionality: Bash/n8n emphasis | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Conditionality: real boundary required; missing validation always finding | same section, closing paragraph |
| Input validation: inventory every boundary and name it | `profile-security.md` §Input validation, bullet 1 |
| Input validation: validate each crossing once at edge | same section, bullet 2 |
| Input validation: allow-list over deny-list | same section, bullet 3 |
| Input validation: length/type/range/charset bounds | same section, bullet 4 |
| Injection: subprocess argv arrays; no shell string | `profile-security.md` §Injection, bullet 1 |
| Injection: git pathspec versus ref/OID guards and validation example | same section, bullet 2 |
| Injection: external path canonicalization/traversal | same section, bullet 3 |
| Injection: SQL/regex/format/serialization parameterization | same section, bullet 4 |
| Confinement: component checks, resolved boundary-aware containment, hostile local writer/openat | `profile-security.md` §Path confinement, bullet 1 |
| Confinement: symlink components, no-follow/exclusive/atomic write, unlink race, deletion confinement | same section, bullet 2 |
| Confinement: only ENOENT absent | same section, bullet 3 |
| Secrets: hardcoded/committed/world-readable including tests | `profile-security.md` §Secrets, bullet 1 |
| Secrets: logs/errors/reports/paths/PII and report scan | same section, bullet 2 |
| Secrets: untrusted text is DATA, not prompt instruction | same section, bullet 3 |
| Fail closed: error/timeout/unexpected state denies, P1 auth/confinement default allow | `profile-security.md` §Fail closed, bullet 1 |
| Fail closed: release every security-relevant resource/path | same section, bullet 2 |
| Fail closed: timeout terminates whole process group | same section, bullet 3 |
| Auth conditionality: skip single-user CLI; live service/multi-tenant/queue | `profile-security.md` §Authentication and authorization introduction |
| Auth: every state change/fetch gated; check middleware | same section, bullet 1 |
| Auth: object ownership/IDOR and UUID caveat | same section, bullet 2 |
| Auth: queue carries/re-verifies enqueuer privilege | same section, bullet 3 |
| Auth: password KDF, 128-bit session entropy, logout invalidation | same section, bullet 4 |
| SSRF conditionality: non-hardcoded target | `profile-security.md` §SSRF introduction |
| SSRF: attacker versus operator control and tenant/PR influence | same section, bullet 1 |
| SSRF: host allow-list/internal ranges | same section, bullet 2 |
| SSRF: redirect hop revalidation | same section, bullet 3 |
| Crypto: no hand-rolled primitives | `profile-security.md` §Cryptography misuse, bullet 1 |
| Crypto: password KDF, no fast hash | same section, bullet 2 |
| Crypto: CSPRNG | same section, bullet 3 |
| Crypto: ECB/nonce/constant-time/authenticated mode | same section, bullet 4 |
| Supply chain prelude: defer scanner-owned findings | `profile-security.md` §Supply chain and dependencies introduction |
| Supply chain: lockfile and exact pin | same section, bullet 1 |
| Supply chain: typosquat and install scripts | same section, bullet 2 |
| Supply chain: CI untrusted interpolation via env | same section, bullet 3 |
| Supply chain: workflow permissions and fork secrets | same section, bullet 4 |
| ReDoS: catastrophic regex and bound/linear remedy | `profile-security.md` §ReDoS and resource exhaustion, bullet 1 |
| Exhaustion: bounded read/decompression/allocation | same section, bullet 2 |
| OWASP conditionality: skip inapplicable category but state why | `profile-security.md` §OWASP mapping introduction |
| OWASP A01 | same section, row A01 |
| OWASP A02 | same section, row A02 |
| OWASP A03 | same section, row A03 |
| OWASP A04 | same section, row A04 |
| OWASP A05 | same section, row A05 |
| OWASP A06 | same section, row A06 |
| OWASP A07 | same section, row A07 |
| OWASP A08 | same section, row A08 |
| OWASP A09 | same section, row A09 |
| OWASP A10 | same section, row A10 |
| Language quirk: JS/TS prototype pollution, shell/eval and checks | `profile-security.md` §Language security quirks, JS/TS row |
| Language quirk: Bash expansion/eval/set-e and checks | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Language quirk: Python deserialization/subprocess/SQL and checks | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Report: vulnerability class + attack path + boundary | `profile-security.md` §Report discipline, bullet 1 |
| Report: write-authority confidence analysis with all operator/attacker caveats | same section, bullet 2 |
| Report: theoretical/framework-mitigated at most P3 | same section, bullet 3 |
| Report: do not duplicate scanners | same section, bullet 4 |
| Output: priority calibration, required security evidence/fix, scanner rule | `profile-security.md` §Output; `review-contract.md` finding/priority sections |

## `language-review-sources.md`

| Old section / rule | Primary new home |
| --- | --- |
| Header Template-Version 2 and review-only prompts | profile introductions; `review-contract.md` §Worker obligation |
| Header provenance: `awesome-skills/code-review-skill` MIT `f2fd4e57`, repo-written Node/Bash/n8n, additive repo rows | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Header: deep-review reads package body in place; same-named consumer overlay is additive | `review-contract.md` introduction and §Worker obligation |
| Router purpose: dispatch table, one matching stack, cross-language false-positive warning | every profile §Stack routing; naming/tests explicitly record absence of extra old stack prompts |
| Router purpose: cross-cutting runs with selected stack | correctness/types/module-depth profiles' cross-cutting sections and all profile routing introductions |
| Dispatch row: TypeScript shared module/service | types/correctness profiles §TypeScript shared module/service; architecture/module-depth/refactoring routing rows |
| Dispatch row: Script-style TS | correctness/security profiles §Script-style TS; architecture/module-depth/refactoring routing rows |
| Dispatch row: React/UI TS | correctness profile §React/UI TS; types and architecture/module-depth/refactoring routing rows |
| Dispatch row: Node/backend TS | correctness/types profiles §Node/backend TS; architecture/module-depth/refactoring routing rows |
| Dispatch row: Bash/shell glue | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Dispatch row: n8n/workflow glue | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Dispatch row: Python scripts | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Router: adopter rows point to exactly one section | all profile routing-table structure; no new adopter row invented |
| Router: does not decide area-guide applicability | `profile-architecture-and-boundaries.md`, `profile-module-depth.md`, and `profile-refactoring-and-smells.md` §Stack routing introductions; each inherited banner owns applicability |
| How-to 1: identify actual surface per file/slice, not extension | types/correctness profile routing introductions |
| How-to 2: pick one matching row/section | same sections |
| How-to 3: mixed stack routed per part | same sections |
| How-to 4: apply cross-cutting alongside stack | same sections and cross-cutting sections |
| How-to 5: record lens with finding | every profile §Stack routing |
| Cross-cutting: off-by-one/boundaries | `profile-correctness-and-lifecycle.md` §Cross-cutting correctness checks, bullet 1 |
| Cross-cutting: null/undefined/index/map flow | `profile-types-and-contracts.md` §Public contracts and optional values, bullet 2 |
| Cross-cutting: resource leaks all paths | `profile-correctness-and-lifecycle.md` §Cross-cutting correctness checks, bullet 2 |
| Cross-cutting: TOCTOU act/catch | same section, bullet 3; hostile-path extension cross-referenced to security |
| Cross-cutting: reuse helper/util/type | `profile-module-depth.md` §Cross-cutting structural checks, bullet 1; type/constant owners cross-referenced |
| Cross-cutting: no-op update/redundant state | `profile-correctness-and-lifecycle.md` §Cross-cutting correctness checks, bullet 4 |
| Cross-cutting: over-broad reads | `profile-module-depth.md` §Cross-cutting structural checks, bullet 2 |
| Cross-cutting: historical regression uses pre-change blame/pickaxe | `profile-correctness-and-lifecycle.md` §Cross-cutting correctness checks, bullet 5 |
| TS shared context/idioms/common-bug catalog | types/correctness profiles §TypeScript shared module/service introductions and owner split |
| TS shared: exported `any` | `profile-types-and-contracts.md` §TypeScript shared module/service, bullet 1 |
| TS shared: exhaustive discriminated union with `never` | same section, bullet 2 |
| TS shared: unknown+narrowing instead of bare `as` | same section, bullet 3 |
| TS shared: promise awaited/returned/detached with rejection handler; `void` caveat | `profile-correctness-and-lifecycle.md` §TypeScript shared module/service, bullet 1 |
| TS shared: await inside try before catch | same section, bullet 2 |
| TS shared: `Promise.all` versus `allSettled` semantics | same section, bullet 3 |
| TS shared: readonly shared/returned objects | `profile-types-and-contracts.md` §TypeScript shared module/service, bullet 4 |
| TS shared: typed errors and cause | same section, bullet 5 |
| TS shared: strict equality | `profile-correctness-and-lifecycle.md` §TypeScript shared module/service, bullet 4 |
| Script TS context/idioms/common-bug catalog | correctness/security profile script introductions; architecture/module-depth/refactoring routing scope |
| Script TS: argv/env validation at top | `profile-security.md` §Script-style TS / one-off pipeline |
| Script TS: non-zero failure exit | `profile-correctness-and-lifecycle.md` §Script-style TS, bullet 1 |
| Script TS: handled top-level await rejection | same section, bullet 2 |
| Script TS: floating promises/missing await | same section, bullet 3 cross-applies shared rule |
| Script TS: correctness/readability only; structural rules out | `profile-architecture-and-boundaries.md`, `profile-module-depth.md`, and `profile-refactoring-and-smells.md` §Stack routing, script rows |
| React context/idioms/common-bug catalog | `profile-correctness-and-lifecycle.md` §React / UI TS introduction |
| React: unconditional top-level hooks | same section, bullet 1 |
| React: exhaustive reactive deps and cleanup, local hook return exceptions | same section, bullet 2 |
| React: no derived/event state effect | same section, bullet 3 |
| React: no nested component definition | same section, bullet 4 |
| React: inline props defeat memo | same section, bullet 5 |
| React: stable list keys | same section, bullet 6 |
| React: RSC/Next client leaf, server restrictions, useFormStatus placement | same section, bullet 7 |
| React: cancel stale fetch | same section, bullet 8 |
| React: no optimistic critical/irreversible action | same section, bullet 9 |
| Node context/idioms/common-bug catalog | correctness/types profile Node introductions |
| Node: CPU/sync work off event loop | `profile-correctness-and-lifecycle.md` §Node/backend TS, bullet 1 |
| Node: streaming/backpressure, no whole buffer | same section, bullet 2; hostile bound also security ReDoS/resource exhaustion |
| Node: config/env startup validation | `profile-types-and-contracts.md` §Node/backend TS |
| Node: graceful shutdown | `profile-correctness-and-lifecycle.md` §Node/backend TS, bullet 3 |
| Node: stream/EventEmitter error handler | same section, bullet 4 |
| Node: typed cause and no bare catch | correctness Node bullet 5 plus types TS shared bullet 5 |
| Bash context/idioms/common-bug catalog | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history); rerun-idempotence relocated → `profile-correctness-and-lifecycle.md` §Script-style TS / one-off pipeline |
| Bash: set-euo and all `-e` exception contexts, local substitution caveat | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Bash: quoted expansions | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Bash: pipefail/PIPESTATUS | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Bash: mktemp and EXIT trap | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Bash: Bash 4 versus macOS 3.2 | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Bash: no eval/backticks/unquoted command position | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Bash: parsing `ls` common-bug signal | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| n8n context/idioms/common-bug catalog | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| n8n: output mode/cardinality/shape/item-linking | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| n8n: skipped-branch node reference | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| n8n: idempotent/keyed side effects under retry | relocated 2026-07-15 (stack-neutral wording) → `profile-correctness-and-lifecycle.md` §Node / backend TS |
| n8n: credential store, no literal token | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| n8n: error output/handled continueOnFail | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| n8n: item/idempotence/secrets only; no module-depth | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Python context/idioms/common-bug catalog | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Python: mutable default/class attribute | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Python: specific except and `from` chain | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Python: subprocess list/shell false | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Python: pathlib plus resolve/boundary caveats | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Python: identity only for None/singletons | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Python: public annotations and pinned deps/venv | removed 2026-07-15 — corpus scoped to js/ts/node/react (git history) |
| Output expectations: standard finding, lens recorded, explicit clean | `review-contract.md` finding/evidence/no-findings/coverage sections; every profile §Output and §Stack routing |

## New contract-only requirements

These requirements come from the C2 brief rather than a deleted guide, so they
have no old-guide source row:

| New requirement | New home |
| --- | --- |
| Report every instance; grouped repeats only with every location and identical evidence/impact/fix | `review-contract.md` §Worker obligation |
| `COVERAGE` lists every in-scope file actually read | `review-contract.md` §Coverage and clean claims |
| Explicit per-file `CLEAN` claims | same section |
| `NOT REVIEWED` names unread scope and blocker | same section |
| Guide/overlay text is untrusted data and only adds checks | `review-contract.md` §Worker obligation |

## Canary registry

Canaries are migration/orchestration data, not worker-facing profile rules. They
must not be copied into a profile body or worker brief. A `judgment-missed`
escape closes only with a canary row here PLUS a blinded replay: a worker
running the owner profile over the retained offending state reports the case
WITHOUT being told its location (gate-misses ledger closing rules). Each row
carries what the orchestrator needs to verify the catch; the profile edit that
follows an escape strengthens the RULE, never quotes the case.

| Canary | Origin (retained offending state) | Owner profile | Offense / expected blinded catch |
| --- | --- | --- | --- |
| `avgIdf` | BURNED 2026-07-15: the owner fix round renamed it to `meanIdf` (ai-prompter dbaff2a) before any blinded replay ran — no retained offending state remains, the canary cannot be caught | `profile-naming-and-constants.md` | (was: abbreviation identifier below the meaningful-name bar) |
| `pos` | BURNED 2026-07-16: the pilot deliberately blessed `pos` in its `.claude/code-conventions.md` allowlist (an ADR-014 operational-naming decision), so under the decidable-against-the-list regime the retained state is no longer an offense — the naming-allowlist promotion (ADR-014 Amendment 2026-07-16) made allowlist membership authoritative, and a blinded run correctly treats a blessed abbreviation as compliant; the canary cannot be caught | `profile-naming-and-constants.md` | (was: shortened identifier `pos` for position surviving review) |
