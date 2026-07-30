# Deep Review Findings

Status: **historical**. All 58 findings were dispositioned; current residual work was
distilled into `docs/plans/backlog.md`.

Дата рев’ю: 2026-07-09  
Репозиторій: `lipchey/dev-standards`  
Режим: read-only review; production code під час рев’ю не змінювався.

## Висновок

Поточний стан — **no-go для production/adoption**. TypeScript, збірка та всі 521 тести проходять, але перевірки переважно ізольовані через injected seams і не ловлять критичні розриви між mock-адаптерами, Git worktrees, GitHub CLI та реальними файловими операціями.

Зведено **58 findings**: 38 P1, 16 P2, 3 P3 та 1 змішаний P1/P2.

Severity:

- **P1** — ламає основний workflow, гарантію безпеки, цілісність даних або adoption.
- **P2** — конкретна correctness/reliability проблема або суттєва прогалина контракту.
- **P3** — hardening, підтримуваність, документація чи низькоризиковий dependency issue.

## Диспозиція (Фаза 6, 2026-07-15)

Повна диспозиція всіх 58 знахідок — передумова зняття onboarding gate (roadmap
Фаза 6.3). Кожна знахідка звірена з ПОТОЧНИМ деревом (HEAD `e77e78f`), не з
початковим станом рев'ю 2026-07-09. Реальність зсунулась відносно roadmap-мапи:
(а) весь `workflow/` підсистему видалено (Phase R, 2026-07-10) → усі WF-* та
generator-findings obsolete; (б) hardening deep-review-енджина Фази 5 §5.0–5.5
(E0–E7) вже **відвантажено** в systemic-gaps батчі ADR-013/014 → DR-01/03–13/17
`fixed` у коді, не `phase-5`. §5.6 shipping (INT-04) відвантажено (v0.15.0–v0.19.0:
consumer shim, `build:deep-review`, `deep_review`-блок, skill-wiring, worktree
copy/reuse/stale) і §5.8 пілот satisfied (fix-mode slices приземлені в ai-prompter
через людсько-рев'юені PR #1/#7/#15/#18) → **Phase 5 закрита 2026-07-15**.

**Підсумок:** 27 fixed · 29 obsolete-after-removal · 2 BACKLOG (DR-14, DR-16).
Жодного `rejected`. Уточнення:
- З 27 fixed — **25 повністю**, а **INT-01 та INT-07 — fixed із tracked-residual
  карв-аутом**: INT-01 (CI-частина виправлена; branch-protection = GitHub-ops-toggle
  поза кодом — не в підрахунку коду); INT-07 (lint+dead-code виправлено;
  coverage/format запарковано). Обидва карв-аути занесені у
  `docs/plans/backlog.md`.
- DEP-02 сам finding (SHA-pin) — fixed; авто-оновлення тих пінів через dependabot —
  окремий проактивний BACKLOG-пункт, не диспозиція DEP-02.
- INT-04: fixed (v0.15.0–v0.19.0). Доставка відвантажена (consumer shim-шаблон,
  `build:deep-review`, `deep_review`-блок, skill verb-wiring, worktree copy/reuse/stale)
  і валідована 29 real-git e2e-кейсами (вкл. consumer-worktree + submodule); §5.8 пілот
  satisfied людсько-рев'юеними slice-PR (#1/#7/#15/#18).

| ID | Sev | Диспозиція | Доказ |
|---|---|---|---|
| INT-01 | P1 | fixed (CI) / ops (branch-protection) | `.github/workflows/quality.yml` реальний, placeholder прибрано; branch protection — GitHub settings, не файл (ops) |
| INT-02 | P1 | fixed | CI ганяє `npm run bootstrap` ПЕРЕД `./verify` (quality.yml:31/33,49/51) |
| INT-03 | P1 | fixed | `quality.json` full = typecheck+`npm test`+build+`test:e2e`; fast має typecheck |
| INT-04 | P1 | fixed | consumer shipping відвантажено (shim+dist+`deep_review`-блок+worktree copy/reuse/stale); 29 e2e-кейсів (вкл. consumer-worktree+submodule); skill verb-wiring готовий. Phase 5 закрита |
| INT-05 | P2 | fixed | `workflow/` видалено + README переписано (нема "unimplemented" суперечності) |
| INT-06 | P2 | fixed | 4 "відсутні" guides існують у `agents/review-guide-templates/`; `skill-catalog.json` заповнений (real url/ref/license, 0 placeholder) |
| INT-07 | P3 | fixed (lint+dead-code) | eslint (fast+full) + knip (full), report-only. Parked (окремо): core-side coverage/format gate — coverage/companion-tests живуть у пілоті (Phase 3/4.2), не в core `quality.json`; BACKLOG-nit, не reopen |
| RUN-01 | P1 | fixed | `exec.ts` detached process-group + `process.kill(-pid,'SIGKILL')` reap — вбиває піддерево |
| RUN-02 | P1 | fixed | `verify-runner.ts` монотонний `deadlineMs` спанить setup+git+checks; `assertBudget` fail-closed на порожньому тірі |
| RUN-03 | P1 | obsolete-after-removal | `generate-skill-wrappers.ts` видалено (Phase 2) |
| RUN-04 | P2 | fixed | `report.ts writeConfined` блокує escape-above-root (lexical+realpath+temp/rename); `scope` — внутрішнє ім'я тіра (staged/fast/full), не attacker-controlled, тож живого експлойту нема. Defense-in-depth nit: `RunnerReport.scope` досі `string`, не звужено до `TierName` (in-root traversal лишається можливим ЯКЩО scope колись стане untrusted) — BACKLOG-nit |
| RUN-05 | P2 | obsolete-after-removal | generator видалено; static wrappers + contract-test |
| RUN-06 | P2 | fixed | `validate.ts DIFF_FILTER_PATTERN=/^[ACDMRTUXB]+$/` — дрейф зі schema закрито |
| RUN-07 | P2 | obsolete-after-removal | усі сайти в видаленому generator; принцип задоволений `report.ts`/`exec.ts`/`git.ts` |
| RUN-08 | P2 | obsolete-after-removal | YAML-scalar рендер жив у generator (видалено); wrappers статичні |
| WF-01..24 | P1/P2 | obsolete-after-removal | увесь `workflow/` видалено (0 tracked files); кожен цитований `workflow/src/*` шлях відсутній. Спадкоємці без регресу (deep-review descriptor-gated). Спец-ноти: WF-08 (data-loss TOCTOU — описував ПОТЕНЦІЙНУ гонку, не зафіксовану втрату; producing code видалено); WF-14 (synthetic token в review-time repro; history-scan знаходить лише synthetic redaction-test фікстуру, не реальний секрет; producing code видалено); WF-19 (fail-open scanner) — виправлено у спадкоємці `deep-review/src/secret-scan.ts` (tri-state fail-closed) |
| DR-01 | P1 | fixed | run-descriptor identity-gate (`slice.ts`,`cli.ts`,`descriptor.ts`) |
| DR-02 | P1 | fixed | preflight enforce enabled/modes/guides_dir + один deadline (`preflight.ts`,`config.ts`) |
| DR-03 | P1 | fixed | `test_ref` enum; довільний `test_cmd` гучно відхиляється (`findings-io.ts`,`types.ts`) |
| DR-04 | P1 | fixed | тест у throwaway worktree; живе дерево не чіпається (`slice.ts`) |
| DR-05 | P2 | fixed | throwaway-worktree + `restoreIndexSafe` (`slice.ts`) |
| DR-06 | P2 | fixed | `infra-blocked` ≠ `fix-failed` (`slice.ts`) |
| DR-07 | P1 | fixed | `PROTECTED_STATUSES` guard — термінальні статуси не переписуються (`classify.ts`,`types.ts`) |
| DR-08 | P1 | fixed | report рендерить Pending/Invalid секції + INCOMPLETE-маркер (`report.ts`) |
| DR-09 | P1 | fixed | handoff completeness-gate + durable verify-stamp (`handoff.ts`,`verify.ts`) |
| DR-10 | P1 | fixed | ancestry-bounded reconcile + CAS mutator (`slice.ts`,`findings-io.ts`) |
| DR-11 | P1 | fixed | `writeConfined` закриває всі 3 суб-дефекти (`runner/src/report.ts`) |
| DR-12 | P1 | fixed | tri-state fail-closed scanner; `report.ts` відмовляє на `unavailable` (`secret-scan.ts`,`report.ts`) |
| DR-13 | P2 | fixed | unique-id валідація (`findings-io.ts`) |
| DR-14 | P2 | BACKLOG | 4 slice-інваріанти не форсяться (line≤0, `[]`/dup slice_files, file∉slice_files) — genuinely open |
| DR-15 | P2 | obsolete-after-removal | workflow-context marker зник; reuse тепер descriptor-gated |
| DR-16 | P2 | BACKLOG | `check-path` досі без `assertSafeRepoPath` (`cli.ts`) — genuinely open |
| DR-17 | P1/P2 | fixed | §7.2 fail-closed project-facts + confinement (`no-touch.ts`,`cli.ts`) |
| DEP-01 | P3 | fixed | `esbuild ^0.25.0` (resolved 0.25.12 / nested 0.28.1) — вище фікса GHSA-g7r4-m6w7-qqqr |
| DEP-02 | P3 | fixed | finding = SHA-pin: actions/checkout+setup-node пришпилені до повного SHA у обох workflow-файлах. (Авто-оновлення тих пінів — окремий проактивний BACKLOG-пункт: core `.github/dependabot.yml` відсутній, `github-actions` ecosystem) |

**BACKLOG-елементи, породжені диспозицією:** DR-14 (slice-invariant enforcement),
DR-16 (`check-path` `assertSafeRepoPath`), DEP-02 auto-update (`dependabot.yml`
`github-actions` у core), + nits: INT-07 core coverage/format gate, RUN-04
`scope:TierName` type-narrow. Занесені у `docs/plans/backlog.md`. INT-01
branch-protection —
platform/ops toggle, не код.

## 1. Інтеграція, CI та repository governance

### INT-01 — P1 — Quality CI фактично відсутній, `main` не захищений

Докази:

- Єдиний quality workflow лежить у `ci/workflows/quality.yml:1`, а не в `.github/workflows/`.
- `ci/workflows/quality.yml:7` містить незаповнений `<base-branch>`.
- GitHub API повернув лише dynamic Dependabot workflow; quality workflow відсутній.
- GitHub API для `main` повернув `Branch not protected`.
- Для перевіреного HEAD немає quality workflow runs.

Вплив: будь-яка зміна може потрапити в `main` без typecheck, тестів, build і review gate.

Рекомендація: додати реальний `.github/workflows/quality.yml`, замінити placeholder, увімкнути required checks і branch protection.

### INT-02 — P1 — CI template не може bootstrap-нути runner у clean clone

Докази:

- `runner/dist/` ігнорується у `.gitignore:2`.
- `verify:6-10` завершується exit 127, якщо `runner/dist/verify-runner.mjs` відсутній.
- CI template після `npm ci` одразу виконує `./verify`; build bootstrap перед цим відсутній.

Вплив: навіть після перенесення workflow у `.github/workflows` перевірка самого `dev-standards` впаде до запуску tier.

Рекомендація: або збирати bootstrap bundle до `./verify`, або постачати versioned runner artifact/shim із перевіркою його відтворюваності.

### INT-03 — P1 — `./verify --full` запускає лише runner-тести

Докази:

- `package.json:15` визначає повний набір runner + workflow + deep-review.
- `quality.json:43-65` запускає лише `npm run test:runner` і у fast, і у full.
- `./verify --full` охопив 167 тестів, тоді як `npm test` — 521.

Вплив: 354 workflow/deep-review тести не входять у заявлений full gate.

Рекомендація: full tier має запускати `npm test`; fast tier — принаймні typecheck і релевантні модульні набори.

### INT-04 — P1 — Workflow/deep-review runtime artifacts не постачаються

Докази:

- `workflow/dist/` і `deep-review/dist/` ігноруються.
- Tracked launchers `workflow`, `tools/workflow-runner.mjs`, `deep-review` або `tools/deep-review-runner.mjs` відсутні.
- `agents/skill-sources/deep-review-refactor.md` не згадує findings JSON чи команди engine (`select-worktree`, `classify`, `commit-slice`, `verify`, `handoff`).

Вплив: deterministic safety gates можуть бути dead code; clean clone/adopting repo бачить лише prose contract.

Рекомендація: постачати versioned launcher/bundle і вписати точний CLI protocol у canonical skill.

**Резолюція (Phase 5, v0.15.0–v0.19.0):** versioned bundle + consumer shim
постачаються (`templates/consumer/scripts/deep-review`, `build:deep-review`); skill
body вписує CLI-протокол (`select-worktree`/`classify`/`commit-slice`/`verify`/`handoff`);
worktree bootstrap copy-not-symlink (ADR-013) + freshness-stamp; 29 real-git e2e. → fixed.

### INT-05 — P2 — Документація суперечить поточному коду

Докази:

- `README.md:5-10` досі каже, що workflow helper та enabled workflow validation не реалізовані.
- Водночас `workflow/src/` і `deep-review/src/` містять повні runtime-модулі та сотні тестів.

Вплив: незрозуміло, що є supported release surface, experimental code чи dead implementation.

Рекомендація: зафіксувати maturity/status кожної підсистеми, installation/adoption flow та відомі обмеження.

### INT-06 — P2 — Skill catalog і guide set неповні

Докази:

- `agents/skill-catalog.json` містить `<verify-at-pin>`, невідомі license/URL і неперевірені refs.
- Canonical skills посилаються на відсутні `refactoring-checklist.md`, `review-output-format.md`, `core-code-guidelines.md` і `security-review.md`.

Вплив: review protocol не відтворюваний, provenance/licensing не завершені, runtime мусить імпровізувати без обов’язкових guide-файлів.

Рекомендація: додати відсутні guides, зафіксувати commit SHA та license кожного external source, перевіряти catalog у CI.

### INT-07 — P3 — Немає lint/format/coverage gate

Докази: `package.json` і `quality.json` не містять lint, formatting або coverage команд.

Вплив: типи й behavior tests зелені, але style drift, dead code та непокриті production adapters не контролюються.

Рекомендація: додати ESLint/format check, coverage thresholds окремо для real edges та integration suites.

## 2. Runner

### RUN-01 — P1 — Timeout не обмежує процес і не прибирає descendants

Файли: `runner/src/exec.ts:58-79`.

Підтверджено:

- timeout 1s + process, що ігнорує SIGTERM, повернувся лише через ~2.26s;
- grandchild пережив timeout і записав marker після завершення runner.

Вплив: check може зависнути безстроково або продовжити змінювати repo після заявленого timeout.

Рекомендація: async spawn, окрема process group/job, SIGTERM grace period, потім SIGKILL всього дерева.

### RUN-02 — P1 — Hard wall-clock budget не охоплює setup, Git, report і empty tier

Файли: `runner/src/verify-runner.ts:65-92`, `runner/src/git.ts:4-11`.

Підтверджено: валідний budget 1s, empty fast tier і fake Git на 2.2s завершилися code 0 через ~2.49s.

Причина: budget перевіряється лише всередині циклу після `runCheck`; Git не має timeout.

Рекомендація: один monotonic deadline на весь tier, remaining-time для Git/checks/report, partial report на budget failure.

### RUN-03 — P1 — Wrapper generator може перезаписати файл поза repo через symlink

Файли: `runner/src/generate-skill-wrappers.ts:241-260`.

Підтверджено: symlink `.agents/skills/foo -> external-dir` призвів до overwrite зовнішнього `SKILL.md`, а `generate()` повернув code 0.

Рекомендація: `lstat` кожного destination component, realpath confinement, відмова від symlink parents, atomic no-follow leaf replacement.

### RUN-04 — P2 — Runner report має traversal через `scope`

Файли: `runner/src/report.ts:18-30`.

Підтверджено: hostile `RunnerReport.scope` із path separators створив JSON поза root. CLI зараз безпечний лише тому, що передає `TierName`, але exported API типізує `scope` як довільний string.

Рекомендація: `scope: TierName`, runtime allowlist/basename validation і confinement самого leaf path.

### RUN-05 — P2 — Stale generated wrappers не виявляються

Файли: `runner/src/generate-skill-wrappers.ts:301-315`.

Підтверджено: після видалення canonical `beta.md` старий `.agents/skills/beta/SKILL.md` лишився, а `check()` повернув `skill wrappers in sync`.

Вплив: видалена/перейменована skill продовжує виконувати застарілі інструкції.

Рекомендація: enumerate generated-marker wrappers, fail на stale у `--check`, безпечно видаляти лише generated wrappers у generate mode.

### RUN-06 — P2 — Hand-validator і JSON Schema вже розійшлися

Файли: `runner/src/validate.ts:388-399`, `schemas/quality.schema.json:74`.

Підтверджено: `diff_filter: "Z"` отримує schema verdict false, але `validate(...).ok === true`; Git пізніше завершується exit 129.

Рекомендація: застосувати точний `^[ACDMRTUXB]+$` у hand-validator і розширити conformance battery/property-based parity tests.

### RUN-07 — P2 — Source filesystem errors інколи приховуються, інколи вилітають uncaught

Файли: `runner/src/generate-skill-wrappers.ts:132-137`, `:184-215`, `:241-260`.

Підтверджено:

- `agents/skill-sources` як regular file спричинив success + skipped check;
- dangling `.md` спричинив uncaught ENOENT;
- multi-file writes неатомарні й можуть лишити partial generation.

Рекомендація: трактувати як “absent” лише ENOENT; інші read/write errors — structured EXIT_FAIL; preflight + atomic generation transaction.

### RUN-08 — P2 — Wrapper YAML scalar серіалізується некоректно

Файли: `runner/src/generate-skill-wrappers.ts:63-108`, `:143-170`.

Підтверджено:

- quoted description `"Use: safely"` рендериться як невалідне `description: Use: safely`;
- `"[danger]"` змінюється зі string на YAML sequence.

Рекомендація: коректний YAML/JSON quoting, duplicate/unknown-key validation, semantic parse/render round-trip test.

## 3. Workflow

### WF-01 — P1 — Реальний `gh pr checks` adapter не може працювати

Файли: `workflow/src/gh.ts:213-273`, `workflow/src/ship.ts:242-275`.

Підтверджені незалежні дефекти:

1. JSON field `conclusion` не підтримується `gh pr checks`.
2. `--watch` не можна комбінувати з `--json`.
3. Real red CI повертає nonzero; generic `run()` кидає `GhError` до parsing, тому `ci_failed`/notification недосяжні.
4. Adapter має фіксований 30s timeout, а `workflow.ship.ci_wait_seconds` не використовується.

Рекомендація: bounded polling через JSON без `--watch`, класифікація `bucket/state`, окремі pending/red/infra outcomes, config-driven deadline.

### WF-02 — P1 — `STATE.md` не є глобальним між worktrees

Файли: `workflow/src/cli.ts:696-718`, `workflow/src/new-feature.ts:244-266`, `workflow/src/ship.ts:73-82`.

Підтверджено: після `newFeature("demo")` main checkout має record, feature worktree — не має файлу або має stale tracked copy. `ship`/`fetch-review` оновлюють не ту копію, а main cleanup лишається на старому state.

Рекомендація: common-git storage або інше єдине зовнішнє state store, shared lock, version/CAS та atomic writes.

### WF-03 — P1 — STATE writers не мають спільного lock/CAS

Файли: `workflow/src/cli.ts:163-228`, `workflow/src/new-feature.ts`, `workflow/src/ship.ts`, `workflow/src/fetch-review.ts`, `workflow/src/cleanup.ts`.

`ship`, `fetch-review`, `cleanup`, `new-feature` виконують read-modify-write поза спільним lock. Два writers можуть прочитати S0 і last-write-wins стерти чужий feature або review_state. `ship` також може interleave з transaction/recover і створити planning/trailer divergence.

Рекомендація: shared global lock для STATE, worktree lock для planning transition, atomic rename і CAS на version/hash.

### WF-04 — P1 — Malformed/unreadable STATE fail-open перетворюється на empty state

Файли: `workflow/src/new-feature.ts:95-102`, `workflow/src/ship.ts:53-62`, `workflow/src/fetch-review.ts:85-95`, `workflow/src/cleanup.ts:118-128`.

Read errors, missing/unclosed frontmatter або truncated file часто підміняються порожнім документом. Наступний write може стерти всі попередні records.

Рекомендація: створювати empty state лише після підтвердженого ENOENT; EACCES/EIO/parse errors — fail closed; exclusive create + atomic update.

### WF-05 — P1 — Branch із frontmatter допускає option injection у `git push`

Файли: `workflow/src/ship.ts:206-218`.

Підтверджено: branch `--all` перетворив argv на `git push -u origin --all` і опублікував усі локальні гілки, включно з додатковою confidential test branch, до пізнішої GH validation.

Рекомендація: `assertSafeFeatureBranch` + `git check-ref-format --branch` до будь-якої network operation; push `HEAD:refs/heads/<validated>`.

### WF-06 — P1 — Persisted SHA інтерпретується як Git option

Файли: `workflow/src/front-matter.ts:712-720`, `workflow/src/commit-scope.ts:47-55`, `workflow/src/diff-range.ts`.

`start_sha`/`base_sha` валідовані лише як strings і потрапляють перед `--`. Safe repro з option-like `start_sha` змусив Git записати diff output у файл поза repo.

Рекомендація: OID allowlist (`40/64` hex), `rev-parse --verify --end-of-options <oid>^{commit}`, ніколи не передавати неперевірений revision operand.

### WF-07 — P1 — Git filenames повторно інтерпретуються як pathspec magic

Файли: `workflow/src/transactions.ts:501-510`.

Підтверджено: tracked filename `:(glob)**` спричинив staging інших файлів, включно з excluded planning file. Post-assert кинув помилку, але staging лишився, бо add/assert поза rollback try.

Рекомендація: `--literal-pathspecs` + `--pathspec-from-file=- --pathspec-file-nul`, snapshot/restore index на будь-якій помилці.

### WF-08 — P1 — Cleanup має TOCTOU data-loss через `worktree remove --force`

Файли: `workflow/src/cleanup.ts:347-359`, `:451-503`, `workflow/src/cli.ts:823-837`.

Cleanliness перевіряється до довгого decision/GH phase; нові edits після snapshot видаляються `--force`.

Рекомендація: прибрати force, повторити worktree association + clean check безпосередньо перед remove, тримати відповідний lock.

### WF-09 — P1 — Cleanup partial progress не відновлюється

Файли: `workflow/src/cleanup.ts:409-421`, `:479-503`.

Crash або STATE-write failure після branch deletion лишає record, але branch уже відсутня; rerun знову виконує `branch -D` і постійно падає.

Рекомендація: idempotent branch deletion з exact-ref existence check, per-record intent/checkpoints, tolerant recovery для already-absent artifacts.

### WF-10 — P1 — Lock protocol допускає permanent busy та cross-host split-brain

Файли: `workflow/src/lock.ts:125-147`, `:152-170`, `:180-229`, `:261-286`.

Підтверджено:

- crash/write failure після exclusive create лишає empty/corrupt lock, який ніколи не steal-иться;
- orphan `<lock>.steal` marker ніколи не reclaim-иться;
- stale check ігнорує stored hostname та застосовує локальний PID oracle до foreign host.

Рекомендація: lease/directory protocol, reclaimable timestamped marker, cleanup on write failure, host-aware policy або справжній distributed lock.

### WF-11 — P1 — Git/hook operations не мають timeout і можуть вічно тримати lock

Файли: `workflow/src/trailers.ts:200-217`, `workflow/src/doctor.ts:408-414`.

`spawnSync` для Git/hook/credential helper не має timeout. Hung hook або credential/network helper блокує process і `.workflow.lock` безстроково.

Рекомендація: bounded async execution, process-tree cleanup, окремі реалістичні deadlines для local Git, hooks і network push.

### WF-12 — P1 — Planning mutation неатомарна і rollback не охоплює перший write

Файли: `workflow/src/planning-io.ts:116-135`.

`savePlanning()` виконується до `try`. Репро з throwing write seam: один write, нуль Git calls, нуль restore attempts. Частковий write лишає corrupt/advanced planning без durable trailer.

Рекомендація: same-directory temp + fsync + rename; write повинен бути всередині recovery protocol; durable snapshot/intent.

### WF-13 — P1 — `feature-start` не відкочує branch/worktree після STATE failure

Файли: `workflow/src/new-feature.ts:236-242`.

Підтверджено: після denied STATE write current branch уже `feature/demo`, record відсутній; retry падає через existing branch. Worktree mode лишає orphan branch/worktree.

Рекомендація: transaction/rollback, включно з поверненням на попередню branch, або durable intent + resumable finalize.

### WF-14 — P1 — Hook diagnostics із секретами комітяться в history

Файли: `workflow/src/transactions.ts:239-256`.

Підтверджено: synthetic token, надрукований rejecting hook-ом, опинився у failure commit message та `git log`.

Рекомендація: лише generic failure subject/trailer у commit; bounded redacted diagnostics — тільки stderr/local report; secret regression test.

### WF-15 — P1 — `gate --force` повертає green, але нічого не розблоковує

Файли: `workflow/src/gate.ts:238-248`, `workflow/src/transactions.ts:323-331`, `workflow/src/cli.ts:1111-1120`.

Force записує `forced_actions` і повертає 0, але state не змінює; наступний `workflow start` знову WRONG_STATE. Запис planning також не commit-иться з trailer.

Рекомендація: atomic one-shot waiver, який consume-иться start, або реальний audited transition; обов’язковий reason.

### WF-16 — P1 — Waiting gate перевіряє divergence лише один раз

Файли: `workflow/src/gate.ts:203-216`, `:264-278`.

Після initial check poll loop re-read-ить лише frontmatter. Інший process може записати advanced state і впасти до commit; waiter побачить precondition і запустить agent на divergent state.

Рекомендація: перевіряти planning + HEAD trailer перед кожним proceed під lock/consistent snapshot.

### WF-17 — P1 — Agent запускається у довільному `fm.worktree`

Файли: `workflow/src/await-and-launch.ts:101-122`, `workflow/src/front-matter.ts:565-575`.

Frontmatter вимагає лише quoted string. Committed planning file з matching trailer може вказати інший repo або sensitive directory як cwd configured agent.

Рекомендація: cwd виводити з canonical planning path / `git rev-parse --show-toplevel`; вимагати equality realpath та git-common-dir association.

### WF-18 — P1 — Truncated GitHub review усе одно просуває state

Файли: `workflow/src/gh.ts:27-34`, `:309-322`, `workflow/src/fetch-review.ts:220-277`.

При >100 threads/comments код лише WARN-ить, пише incomplete JSON без `complete/truncated` field і ставить `processing_review`, хоча process contract вимагає відповісти на кожен thread.

Рекомендація: cursor pagination для threads/per-thread comments; якщо cap/error — EXIT_NEEDS_HUMAN до write/STATE advance.

### WF-19 — P1 — Secret scanner fail-open

Файли: `workflow/src/secret-scan.ts:158-166`, `workflow/src/ship.ts:219-222`.

Absent/non-executable scanner повертає `null`, ідентичний clean result. Doctor можна не запускати, а scanner може зникнути після doctor.

Рекомендація: tri-state `{clean, hit, unavailable}`; enabled ship має fail closed на unavailable.

### WF-20 — P1 — `workflow.ship.notify:false` ігнорується

Файли: `workflow/src/types.ts:103-119`, `workflow/src/ship.ts:248-260`.

Config field не читається; notifier викликається завжди. Missing webhook повертає skipped warning, але ship дивиться лише на `.ok` і губить warning.

Вплив: explicit privacy/notification opt-out не працює.

Рекомендація: honor boolean через explicit no-op result; surfaced skipped/warning status.

### WF-21 — P1 — Doctor false-green для blank guide і false-red для arming

Файли: `schemas/quality.schema.json:145`, `runner/src/validate.ts:255-272`, `workflow/src/doctor.ts:200-217`, `:384-387`, `workflow/src/new-feature.ts:75-78`.

Підтверджено:

- `required_review_guides: [""]` проходить validator;
- doctor/new-feature резолвлять empty path у repo root і вважають guide наявним;
- real `probeWrapper` завжди повертає `ok:false`, тож `workflow doctor --arm` гарантовано red.

Рекомендація: non-empty normalized repo-relative file paths, `isFile`, no traversal/absolute; реалізувати production wrapper resolver.

### WF-22 — P2 — Конфіг містить мертві або не виконані controls

Поля `cmux_mode`, `loopback_mode`, `reviewer_independence`, `timeouts.default_work_seconds` не керують runtime поведінкою; `new-feature` завжди пробує cmux навіть у manual mode. `ci_wait_seconds` та `ship.notify` мають окремі P1 defects вище.

Рекомендація: або реалізувати кожну семантику, або прибрати поле зі schema/docs; додати config-to-behavior contract tests.

### WF-23 — P2 — `shipped` commit створюється до результату CI

Файли: `workflow/src/ship.ts:239-275`.

Planning state/trailer переходять у success `shipped` до CI watch. На red/timeout feature record стає `ci_failed`, але planning лишається `shipped`; звичайний gate ship-feature більше не має precondition, retry можливий лише special direct path.

Рекомендація: commit `shipped` після green/explicit no-wait або визначити recoverable failure transition і нормальний retry contract.

### WF-24 — P2 — CRLF робить workflow непридатним на Windows/autocrlf

Файли: `workflow/src/front-matter.ts:171-179`; `.gitattributes` відсутній.

Підтверджено: CRLF frontmatter кидає `cr-not-allowed`; splitters також вимагають exact `---`.

Рекомендація: normalize CRLF на read; додатково зафіксувати LF для state/planning у `.gitattributes`.

## 4. Deep-review engine

### DR-01 — P1 — `commit-slice` не доводить, що працює в selected worktree

Файли: `deep-review/src/cli.ts:178-199`, `deep-review/src/slice.ts:229-342`.

Підтверджено: запуск на named base branch `main` створив commit і просунув HEAD.

Рекомендація: durable selection context/token; перевірка git-common-dir, exact worktree association і expected branch (`deep-review/*` або валідований workflow marker) у commit/verify/handoff.

### DR-02 — P1 — `deep_review.enabled`, modes, budget і `guides_dir` не виконуються

Файли: `deep-review/src/config.ts:13-30`, `deep-review/src/cli.ts`.

Підтверджено: valid config із `enabled:false`, modes лише `review-only` та budget 1s не завадив review-and-refactor commit. Test/verify spawns не мають timeout; `guides_dir` не використовується.

Рекомендація: central preflight на кожній mutating command, mode allowlist, one deadline для всього pass, explicit guide loading.

### DR-03 — P1 — Findings-provided `test_cmd` виконується з повними правами process

Файли: `deep-review/src/findings-io.ts:188-208`, `deep-review/src/slice.ts:290-305`.

Findings file названий untrusted, але `test_cmd` перевіряється лише як non-empty/control-free argv і потім запускається без sandbox/allowlist. `shell:false` захищає від shell parsing, але не від довільних filesystem/network/Git side effects самого executable.

Рекомендація: approved test commands із trusted manifest/controller, sandbox/restricted environment, no inherited credentials, або ручне підтвердження command provenance.

### DR-04 — P1 — Unstaged out-of-slice/no-touch test side effects лишаються

Файли: `deep-review/src/slice.ts:283-328`, `:330-377`, `tests/deep-review/slice.test.ts:567-589`.

Post-test gate дивиться лише staged index. Test, який змінив coverage/generated/source/no-touch file без staging, лишає dirty residue, а finding стає fixed. Чинний test прямо очікує залишений `coverage/lcov.info`; це блокує наступний slice pre-gate.

Рекомендація: snapshot/restore повного index+worktree або isolated test workspace; allowlist disposable outputs з явним cleanup.

### DR-05 — P2 — RED rollback не відновлює повний index/worktree

Файли: `deep-review/src/slice.ts:343-377`.

Підтверджено: staged new slice file класифікується “untracked in HEAD”, але `git clean -f` не видаляє його, бо він уже tracked в index; результат — `A  src/new.ts` і revert failure. Out-of-slice effects також не відкочуються.

Рекомендація: captured pre-test index/worktree snapshot; reset index перед clean; deterministic restore всіх test-created changes.

### DR-06 — P2 — Spawn failure помилково стає `fix-failed` + EXIT_OK

Файли: `deep-review/src/slice.ts:94-105`, `:290-377`.

Missing executable дає `status:null`, але engine трактує це як звичайний red test, відкочує valid edit і записує `fix-failed` із success exit.

Рекомендація: mirror `verify.ts` tool-failure handling — EXIT_FAILURE + MachineError; окремий lifecycle state для infrastructure failure.

### DR-07 — P1 — Classify переписує terminal statuses

Файли: `deep-review/src/classify.ts:43-49`.

Підтверджено: повторний classify змінив `fixed/sha=abc` на `pending/sha=abc`; `fix-failed` також не захищений.

Рекомендація: classify лише initial/unclassified records або preserve всі terminal states; валідована transition table.

### DR-08 — P1 — Report приховує `pending` та `invalid`

Файли: `deep-review/src/report.ts:90-101`.

Review-only file з одним pending finding зрендерив усі секції `_None._`. Unsafe findings зі status invalid також зникають.

Рекомендація: секції Pending/Invalid або fail report як incomplete; regression tests для review-only.

### DR-09 — P1 — Handoff не перевіряє readiness, verify чи clean HEAD

Файли: `deep-review/src/handoff.ts:144-156`, `:192-218`, `deep-review/src/verify.ts:91-119`.

Handoff повертає success із pending findings; pending не входить у summary. Verify outcome ephemeral: немає `verified_sha`, а handoff можна викликати без verify або після нових змін.

Рекомендація: fail closed при pending/inconsistent findings, durable verified SHA/state, clean worktree та trailer/SHA validation перед handoff.

### DR-10 — P1 — Git commit і findings state неатомарні

Файли: `deep-review/src/slice.ts:337-342`, `deep-review/src/findings-io.ts:56-61`, `:397-400`.

Commit створюється до запису `status:fixed`/SHA. Injected write failure залишив HEAD advanced і worktree clean, але durable findings — pending.

Рекомендація: recovery via commit trailer, intent journal, atomic temp+fsync+rename, explicit partial-commit state.

### DR-11 — P1 — Report path не confined і write не atomic

Файли: `deep-review/src/cli.ts:213-225`, `deep-review/src/report.ts:140-173`.

Підтверджено:

- `paths.reports: "../outside"` створив report поза repo;
- missing nested directory дала ENOENT, бо mkdir відсутній;
- symlink leaf був followed і target перезаписаний.

Рекомендація: reuse runner report confinement, realpath checks, mkdir, temp+rename/no-follow.

### DR-12 — P1 — “Secret-scanned” report fail-open без scanner

Файли: `agents/skill-sources/deep-review-refactor.md:79-81`, `deep-review/src/report.ts:140-170`, `workflow/src/secret-scan.ts:158-166`, `tests/deep-review/report.test.ts:191`.

У repo немає `tools/run-gitleaks`; scanner повертає clean `null`, і test кодифікує no-op success.

Рекомендація: scanner availability — mandatory для write; unavailable має бути explicit failure/status, а не clean.

### DR-13 — P2 — Duplicate finding IDs роблять другий finding недосяжним

Файли: `deep-review/src/findings-io.ts:334-353`, `deep-review/src/slice.ts:233-238`.

Validator не перевіряє uniqueness, а `commitSlice` використовує `.find(id)`. Якщо перший duplicate уже fixed, другий pending більше неможливо обробити.

Рекомендація: unique ID validation з точним indexed error path.

### DR-14 — P2 — Findings schema не забезпечує slice invariants

Файли: `deep-review/src/findings-io.ts:281-331`.

Приймаються:

- `line <= 0`;
- explicit `slice_files: []`;
- duplicate slice paths;
- `finding.file`, якого немає у `slice_files`.

Вплив: diagnostics некоректні, empty slice неробочий, report може заявити fix у file A, коли commit торкнувся лише file B.

Рекомендація: positive line, `minItems:1`, dedupe, mandatory primary-file membership.

### DR-15 — P2 — Workflow context визначається лише presence marker

Файли: `deep-review/src/worktree.ts:125-128`, `:271-279`, `deep-review/src/handoff.ts:199-216`.

Stale/copied marker або навіть directory з відповідним ім’ям у base checkout/non-git dir дає `reuse-workflow`. Marker frontmatter, recorded branch/worktree та Git association не перевіряються.

Рекомендація: parse marker, require regular file, realpath cwd equality, current branch і `git worktree list` association.

### DR-16 — P2 — `check-path` не валідовує repo-relative path

Файли: `deep-review/src/cli.ts:126-134`.

Safe repro: `check-path ../tools/run-gitleaks` повернув `editable`. CommitSlice пізніше відмовить, але advisory command вводить caller в оману.

Рекомендація: reuse `assertSafeRepoPath` і повертати usage/wrong-state для unsafe operands.

### DR-17 — P1/P2 — Malformed/missing project facts fail-open зменшує no-touch set

Файли: `deep-review/src/no-touch.ts:45-58`, `:88-107`, `deep-review/src/cli.ts:73-79`.

Typo heading `## No-Touch Zone` із `.agents/**` дав baseline-only set без warning. Missing/unreadable configured facts також продовжує mutation. `no_touch_globs_ref` не confined перед resolve.

Рекомендація: mutating mode fail closed на missing/unparseable configured policy; read-only mode — loud warning; confine referenced file under repo.

## 5. Dependency та supply-chain hygiene

### DEP-01 — P3 — Low advisory у nested esbuild

Докази:

- `tsx@4.22.4` тягне `esbuild@0.28.0` (`package-lock.json:1031`).
- `npm audit` знайшов `GHSA-g7r4-m6w7-qqqr`, severity low, fix available.
- Advisory стосується Windows development server; поточний repo його не запускає.

Рекомендація: оновити `tsx`/lockfile, переконатися, що nested esbuild >= fixed version, повторити audit і повний test/build.

### DEP-02 — P3 — GitHub Actions dependencies не pinned до immutable SHA

Файл: `ci/workflows/quality.yml:15-18`, `:32-35`.

`actions/checkout@v4` і `actions/setup-node@v4` використовують mutable major tags.

Рекомендація: pin full commit SHA з Renovate/Dependabot updates.

## 6. Архітектурні першопричини

1. **Mock seams без production contract tests.** Тести приймають synthetic GH JSON, injected green wrapper probe та окремі STATE copies, тому зелені unit tests не гарантують реальну сумісність.
2. **Кілька джерел істини.** JSON Schema, hand-validator, TypeScript types, canonical skill prose і runtime behavior дрейфують незалежно.
3. **Worktree-local файл використаний як global registry.** Це фундаментально несумісно з кількома checkout-ами без common storage/coordination.
4. **Synchronous process APIs використовуються для bounded orchestration.** `spawnSync` ускладнює deadline, cancellation і process-tree cleanup.
5. **State змішує file write, Git index, commit і external calls без journal/CAS.** Через це crash windows створюють divergence та нерезюмовані partial states.
6. **Prose guarantees не підкріплені executable entrypoint.** Найсильніше це видно у deep-review skill, де engine не постачається й не викликається.

## 7. Результати перевірок

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npm run test` — **521/521 passed**.
- Runner tests — 167 passed.
- Workflow tests — 261 passed.
- Deep-review tests — 93 passed.
- `./verify --doctor` — passed із advisory про `.githooks`.
- `./verify --fast` — passed.
- `./verify --full` — passed, але запускає лише runner tests.
- `./tools/standards-sync --check` — passed.
- `npm audit` — 1 low, 0 moderate/high/critical.
- Remote GitHub — quality workflow відсутній; `main` unprotected.
- Робоче дерево після review було clean.

## 8. Рекомендований порядок виправлень

1. Увімкнути реальний CI та branch protection; зробити clean-clone bootstrap.
2. Перенести STATE у global/shared storage, додати shared lock, CAS та atomic writes.
3. Закрити Git ref/OID/pathspec validation до будь-яких Git/network effects.
4. Переписати GitHub CI adapter як bounded JSON polling із contract smoke tests проти реального `gh`.
5. Прибрати cleanup `--force`, зробити cleanup і workflow transactions resumable/idempotent.
6. Довести lock protocol до crash-safe/host-aware стану й додати process timeouts.
7. Постачати deep-review runtime; enforce selected worktree, config modes/budget та durable verify/handoff state.
8. Зробити scanners fail-closed, а report/wrapper writes — confined і atomic.
9. Усунути schema/validator/docs drift та додати cross-module end-to-end tests.
10. Після P1 — CRLF portability, stale wrappers, findings invariants, dependency/action pinning, lint/coverage.
