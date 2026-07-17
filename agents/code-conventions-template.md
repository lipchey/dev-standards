# Code Conventions (template)

Starting structure for repository placement and coding rules. The onboarding
seeder copies this file to `.claude/code-conventions.md`; replace every fill-in
prompt with concrete repository rules, delete sections that do not apply, and
remove this paragraph.

## Structural principles

Fill in the small set of principles that decide structure when several homes
look plausible. State the constraint and the failure it prevents.

## Root layout

List files that must remain at the root for tool discovery, plus the approved
homes for generated output, local tooling, and temporary artifacts.

## Dependency direction

Describe allowed dependency edges and forbidden reverse or cross-boundary
imports. Keep the detailed graph in `project-facts.md`.

## Where code goes

Map each top-level source area to its responsibility. Include the rule for new
files that do not yet have an obvious home.

## Reuse before create

Define the search order for existing constants, types, and helpers before a new
one is introduced, including where shared definitions belong.

## Constants and types placement

Name the canonical homes for constants and types. Require named constants for
non-obvious values and document any format-owned literal exceptions. Declare
where type and interface definitions live (the types home) and record the
standing exception: a React component's own props interface stays beside the
component, not in the shared home.

## Naming and language

Record identifier, comment, and test-title rules, including allowed exceptions
for external schemas or user-facing content.

Make the naming standard OPERATIONAL, never aspirational. Pick one and write it
down: an explicit blessed-abbreviation allowlist (with the rule "a new
abbreviation is added to the list in the same PR that introduces it"), or an
explicit "abbreviations are fine" stance. A bare "use descriptive names" rule
backed only by a length gate leaves the aspirational half ungated and guarantees
arbitrary, reviewer-dependent enforcement.

If you choose the allowlist, start from this universal baseline and extend it
with your domain's abbreviations - each added in the same PR that introduces it -
kept alphabetized on one line:
`api, attr, buf, cfg, cli, cors, css, ctx, db, deps, dir, dom, env, err, hmac,
html, http, id, idx, iso, json, kv, len, max, meta, min, ms, msg, num, opts,
params, prev, px, raw, sql, src, str, tmp, tok, ui, url, utc, uuid, ws`.
A compound of blessed abbreviations and whole words (`msGap`, `rawId`) is
compliant; where a min-length gate is active, the two-character entries (`db`,
`id`, `kv`, `ms`, `px`, `ui`, `ws`) are only ever compound components, never
standalone names. Spell out anything not on the list (`sr` -> `sampleRate`,
`ev` -> `event`); domain terms (`matcher`, `tracker`, `normalize`) are words, not
abbreviations, and never need listing.

## Tests

State where tests and fixtures live, how source areas map to their tests, and
which test level owns each kind of behavior.

## When to add a package or module

Define what justifies a new boundary. The trigger is the LAYER, not the caller
count: a new layer of logic worth isolating for its own sake — to sharpen the
architecture and give AI sessions a stronger, compiler-enforced boundary to work
within — is reason enough, even at a single consumer. Speculative runtime
abstractions still wait for a real caller (YAGNI). List the concrete triggers
this repo honors (e.g. a portable/platform-free concern, an independent runtime
or release contract, a shared wire boundary).
