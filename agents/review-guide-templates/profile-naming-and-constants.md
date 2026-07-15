# Naming and Constants Review Profile

You review ONLY through this lens: name meaningfulness, constant placement and
reuse, inline scalar meaning, and comment quality. Do not turn correctness,
tests, typing, architecture, or security concerns into findings from this
profile; use the named cross-references only to avoid losing a shared edge.

Template-Version: 3 (review-recall 2026-07-15)

Guide filenames in the provenance notes below refer to the RETIRED pre-profile
corpus (deleted in the profile rewrite, alive in git history); `TRACEABILITY.md`
maps every retired section to its new owner.

This profile carries the relevant share of the repo-owned
`core-code-guidelines.md` baseline. It also carries the ubiquitous-language
prompt distilled from the MIT sources attributed in `clean-architecture.md`:
`ramziddin/solid-skills` @ `b113ce6`, `wondelai/skills`
clean-architecture @ `326b380`, and
`affaan-m/everything-claude-code` hexagonal-architecture @ `4092795`.
Those excerpts remain paraphrased; no verbatim blocks are copied.

Stack-routing structure is inherited from `language-review-sources.md`. Its
lenses were distilled as paraphrased excerpts from
`awesome-skills/code-review-skill` (MIT, pinned `f2fd4e57`) - the per-language
guides, `code-quality-universal.md`, `common-bugs-checklist.md`, and
cross-cutting async/error notes. Shell, n8n, and Node lenses were written from
that universal material plus repo experience; upstream has no dedicated lens
for them.

## Conditionality

- Apply this lens at full strength on production code paths.
- On one-off scripts and throwaway glue, correctness and safety still apply but
  naming polish and test-depth prompts relax.
- The constants and types placement rules apply only where the repo actually
  keeps the named home, visible in the layout or declared in
  `.claude/code-conventions.md`. A repo without that home is out of scope for
  that rule.
- The cross-boundary ubiquitous-language prompt is strong for multi-context
  domains and often inapplicable to a small single-purpose repo. Do not invent
  bounded contexts.

## Naming and readability

Judgment prompts:

- Does each name say what the thing is/does in the repo's ubiquitous language,
  or does it mislead (a `get` that mutates, a `list` that returns one, a boolean
  named for the false case)?
- Is intent obvious without a comment, or does non-trivial logic go unexplained
  where a one-line why-comment would save the next reader? More comments is not
  better; the missing *why* on a surprising line is the finding.
- Needless duplication and needless indirection are owned by
  → see `profile-structure-and-dependencies.md` §Duplication, dead code, and
  speculative flexibility.

## Constants placement and reuse

Where a constants home exists:

- Is a non-obvious scalar written inline in logic where a named constant would
  carry its meaning? The `constantsHome` preset already owns one narrow case in
  the files it lints - a module-scope `const` bound to a bare primitive literal -
  so leave that to the gate and judge what it cannot see: literals in call
  arguments and expressions (`setTimeout(fn, 500)`), function-local literals,
  and literal-only arithmetic (`45 * 60 * 1000`).
- Whether a literal is obvious enough to inline is a judgment, and a repo may
  document its own format-owned exceptions.
- A new constant goes in that home; an existing one is reused, not re-declared.

Type/interface placement and strict-typing depth are owned by
→ see `profile-types-and-contracts.md` §Type placement and reuse.

## Comments

Judgment prompts:

- Does each comment carry information the code cannot - a non-obvious why, a
  constraint, an external gotcha, a deliberate trade-off? Boilerplate is a
  finding to delete, not keep: file-header banners restating the module name,
  section dividers, play-by-play narration of the next line, notes addressed to
  the reviewer ("changed this to fix X"), and commented-out code.
- Does every file-header line name a constraint rather than summarize? A header
  line survives only if deleting it invites a concrete bug or wrong fix.
  Retellings of what the file does, usage examples reproducible from the code or
  configuration, and specification text restated without adding a local
  constraint or concrete failure consequence are findings even when accurate.
  Use the delete test as the tie-breaker: a specification-derived line that
  names one concrete constraint stays, as do markers carrying non-derivable
  state.
- Are all comments (doc comments included) written in English? A non-English
  comment is a finding regardless of the team's working language.
- Do comments use block form `/* */` (`/** */` for doc comments) in languages
  that support it? Line form is acceptable only where a tool or the language
  itself mandates it - directives (`// eslint-disable-next-line`,
  `/// <reference>`, `//go:build`), shebangs, and languages whose comment or doc
  syntax is line-based by spec (Python/shell/YAML `#`, Rust `///`, Go doc
  comments).

The structural smell where a comment deodorizes confusing code is owned by
→ see `profile-structure-and-dependencies.md` §Code-smells taxonomy,
"Comments-as-deodorant". Apply this section first: a non-derivable why, gotcha,
or trade-off is a KEEP, not deodorant.

## Ubiquitous language across boundaries

Weighting: strong for multi-context domains; often none for a small
single-purpose repo.

- **Ubiquitous language matches `project-facts.md`.** A term that drifts across
  a boundary (`user` vs `account` vs `customer` for the same thing) breeds
  mistranslation bugs. **Check:** compare domain identifiers against the domain
  terms in `project-facts.md`; drift across a boundary is a finding. This
  profile owns intra-module naming and this cross-boundary naming angle.

The remaining bounded-context and shared-state rules are owned by
→ see `profile-structure-and-dependencies.md` §DDD boundaries.

## Stack routing

The stack router is conditionality, not an extra checklist. Identify the
surface by what the code actually is, one file or slice at a time. If a file
mixes stacks, apply the appropriate row to each part. Record the selected row
with each finding so a mis-routed lens can be challenged.
Adopting repos may add rows for their own stacks; every row points to exactly
one matching section or weighting.

| Surface | Apply this naming/constants lens |
| --- | --- |
| TypeScript service / shared module | full strength for long-lived public names and established homes |
| Script-style TS / one-off pipeline | lighter naming polish; correctness and safety remain elsewhere |
| React / UI TS | full strength for component, prop, hook, and state names |
| Node / backend TS | full strength for long-lived runtime code; lighter for one-off CLI glue |
| Bash / shell glue | lighter; do not manufacture abstractions or naming ceremony |
| n8n / workflow JS glue | lighter; judge expression/node intent without importing module-design rules |
| Python scripts | weight by lifetime and callers, as for other scripts |

The old language router contains no additional stack-specific
naming/constants/comment prompts. Do not import rules from another stack or
invent a stack-specific naming checklist.

## Shared-edge cross-references

- A new helper, util, or type that duplicates an existing repo definition is
  owned by → see `profile-structure-and-dependencies.md` §Cross-cutting
  structural checks. Constant redeclaration remains owned here.
- Cognitive load caused by unclear names is evaluated through the structural
  symptom rule in → see `profile-structure-and-dependencies.md` §The three
  complexity symptoms.

## Output

Follow `review-contract.md` exactly. Report every applicable instance, include
the required per-file `COVERAGE`/`CLEAN` claims, and do not manufacture P3
naming or comment noise when this lens is clean.
