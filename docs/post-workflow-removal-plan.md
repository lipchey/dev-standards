# Post-workflow-removal roadmap

> Статус: затверджено 2026-07-10 (стратегічне ревью dev-standards).
> Старт виконання: ПІСЛЯ мержа видалення `workflow/` (гілка `ch/workflow-removal`).
> Правило виконання: кожна фаза — окрема сесія з low-level планом і Gate P
> (`codex-plan-review`) перед диспатчем; Gate C (`codex-chain`) після коду.
> Effort: S ≈ ≤0.5 сесії, M ≈ 1 сесія, L ≈ кілька сесій.

## Передумови (мають бути істинними до старту)

- [ ] `workflow/` видалено з main; тести зелені (~299 після видалення).
- [ ] deep-review більше не імпортує з `workflow/` (4 символи підняті в
      `deep-review/` або `runner/`: createSecretScanner, sanitizeFeatureSlug +
      SlugError, defaultFeatureWorktree, PLANNING_FILE_NAME).
- [ ] Пін ai-prompter бампнуто на removal-SHA (Фаза A removal-плану).

## Фаза 1 — Ядро самоверифіковне (S) — INT-01, INT-02

1. Bootstrap для чистого клону: `npm run bootstrap` (= `npm ci && npm run
   build`) або `scripts/bootstrap`; README-крок «clone → bootstrap → ./verify`.
2. Активувати CI на самому dev-standards: `ci/workflows/quality.yml` →
   `.github/workflows/quality.yml`, `<base-branch>` = `main` (fast на PR,
   full на push у main). Branch protection для соло не потрібен — червоний
   Actions-ран на main = сигнал.

**Acceptance:** чистий клон → bootstrap → `./verify --full` зелений локально
і в Actions.

## Фаза 2 — Видалити генератор skill-wrappers (S)

Після видалення workflow виживає один скіл (`deep-review-refactor`) — 648 LOC
`runner/src/generate-skill-wrappers.ts` + ~60 тестів
(`generate-skill-wrappers.test.ts`, більша частина `standards-sync.test.ts`)
обслуговують генерацію, яка більше не потрібна.

1. Видалити генератор і його тести; wrapper-и вижившого скіла
   (`.agents/skills/`, `.claude/skills/` у консюмері) закомітити статично.
2. `tools/standards-sync` звузити до manifest-валідації (або видалити, якщо
   `validate-quality-manifest` CLI покриває).
3. Оновити ADR-003/010: канонічне тіло + статичний вказівник; генерація
   скасована.

**Acceptance:** генератор-коду нема, тести зелені, wrapper-и в пілоті статичні.

## Фаза 3 — Детерміністичні аналізатори в тірах (M)

Найдешевший важіль якості AI-генерованого коду: розширити тіри пілотного
`quality.json` (і зафіксувати як дефолт-рекомендацію для ADOPTION.md):

- `staged`: + ESLint (typed rules) по staged fileset (`{files:...}`).
- `fast`: typecheck + vitest + ESLint.
- `full`: + knip (мертвий код — типовий слід AI) + gitleaks.
- Нові чеки заходять як `mode: report-only` → blocking після ~тижня без
  false-positive шуму.
- Baselines/ratchets НЕ реалізовувати, поки не з'явиться перший report-only
  чек, якому реально потрібен baseline (YAGNI — слот у схемі вже є).

**Acceptance:** пілотний quality.json з новими чеками, хуки вкладаються в
бюджети тірів, нуль false-positive блоків за тиждень використання.

## Фаза 4 — Enforcement «новий код = нові тести» (M)

Мета: агенти пишуть тести паралельно з кодом, і тести додають цінність, а не
масу. Три рівні — два механічні (детерміністичні, в тірах) + один judgment
(гайд, який читають gate-скіли). Глобальний %-поріг покриття свідомо НЕ
вводиться ніколи — саме він продукує тести-заради-тестів.

### 4.1 Companion-tests check у staged (S)

`tools/check-companion-tests.mjs` у ядрі: якщо staged diff додає/змінює файли
під src-глобами (fileset у quality.json), а серед staged нема жодного
тест-файла (`*.test.*`, `tests/**`) — fail з підказкою. `bypassable: true`
(escape hatch для чистих рефакторів/конфігу; байпас лишає слід у звіті).
Це евристика-нагадування на швидкому шляху, не доказ покриття.

### 4.2 Diff-coverage у full (M)

`tools/diff-cover.mjs` (dep-free, ~150 LOC): парсить coverage-JSON
(`vitest --coverage`, v8/istanbul) + `git diff -U0 <base>...HEAD`; рахує
покриття ТІЛЬКИ доданих/змінених рядків. Поріг старт 70%; exclude: types,
config, generated, glue. Спершу `mode: report-only`; blocking після
калібрування. Покриття диффа — чесний енфорс «новий код приходить з
тестами», без податку на легасі й без стимулу писати беззмістовні тести на
старий код.

### 4.3 Гайд `testing.md` (S) — judgment-рівень

Новий `agents/review-guide-templates/testing.md`, wired у gate-скіли
(codex-chain / codex-plan-review читають гайди — рев'ю-енфорсмент). Ядро
доктрини:

- Тест перевіряє ПОВЕДІНКУ через публічний контракт, не імплементацію.
  Мок-дзеркала внутрішніх викликів заборонені — саме вони роблять
  рефакторинг важким.
- Тест мусить вміти впасти: не можеш назвати правдоподібний баг, який він
  зловить — не пиши його.
- Кожен bugfix: спершу тест, що відтворює баг (red), потім фікс (green).
- Не тестувати: типи (ловить tsc), стиль (ESLint), чужі бібліотеки,
  тривіальні гетери/конфіг.
- Менше глибших тестів краще за більше дрібних; snapshot-дампи — лише з
  явним обґрунтуванням.
- Перед рефакторингом — characterization tests на поточну поведінку. Тест,
  що падає без зміни поведінки, — кандидат на переписування/видалення.
- Видалити тест, який ніколи не падав і дублює детерміністичний гейт, —
  легальний клінап, не втрата.

### 4.4 Mutation testing (audit) — ПАРКОВАНО

Stryker в `audit`-тірі — вмикати лише якщо diff-coverage покаже
зелені-але-беззубі тести (YAGNI до появи сигналу).

**Acceptance:** 4.1 блокує коміт нового src без тестів у пілоті; 4.2 пише
звіт у `reports/quality/`; 4.3 гайд присутній у guide-списку gate-скілів.

## Фаза 5 — Deep-review fix-mode: hardening + shipping (L)

Мета: fix-mode (`commit-slice`) безпечний, коректний і реально підключений.
Порядок всередині фази жорсткий: безпека → коректність → доставка → e2e →
пілот. Закриває DR-01/03/07/08/09/10/11 та INT-04.

### 5.1 Вбити клас DR-03 дизайном (M)

У findings JSON заборонити довільний `test_cmd` argv. Замінити на
`test_ref`: посилання на named check із `quality.json` АБО `verify:fast` /
`verify:full`. Виконання — через runner-івський `exec.ts` (shell:false,
таймаут, group-kill). `findings-io` відхиляє старий формат. Єдине джерело
виконуваної істини = маніфест; клас ін'єкції зникає, а не «валідується».

### 5.2 Worktree-proof gate — DR-01 (S)

Перед будь-якою мутацією `commit-slice` доводить: cwd у межах вибраного
worktree-запису, git-dir збігається з метаданими worktree, поточна гілка ≠
base. Інакше — відмова з окремим machine-error (нічого не мутовано).

### 5.3 Confinement записів — DR-11 (S)

Report/findings-записи через патерн `runner/src/report.ts`
(path-confinement + tmp + atomic rename), корінь = `paths.reports`.

### 5.4 Коректність станів — DR-07/08/10 (M)

`classify` ніколи не перезаписує термінальні статуси; `report` показує
pending/invalid лічильники (не ховає); порядок commit → findings-state з
реконсиляцією після крешу через trailer-scan (`Deep-Review-Slice: <id>` у
`git log`).

### 5.5 Handoff gate — DR-09 (S)

`handoff` відмовляє, поки не виконано ВСЕ: всі findings у термінальному
статусі ∧ verify зелений із записаним `verified_sha == HEAD` ∧ worktree
чистий.

### 5.6 Shipping — INT-04 (M)

`build:deep-review` у bootstrap консюмера; шим `deep-review` у корені
консюмера (аналог `verify`, зі stamp-guard); блок `deep_review` заповнений у
пілотному quality.json; скіл `deep-review-refactor` wired на CLI-верби.

### 5.7 Real-git e2e (M)

`tests/deep-review-e2e/` на тимчасовому git-репо БЕЗ мок-сімів (закриває
root cause §6.1 «mock seams не ловлять реальний git»): happy slice-коміт;
out-of-slice dirty → відмова; red test → revert тільки slice; no-touch →
блок; запуск на main → відмова; handoff з pending → відмова.

### 5.8 Пілот (S)

На ai-prompter: спершу повний review-only цикл; потім fix-mode на ОДНІЙ
низькоризиковій P2-знахідці; людське рев'ю диффа; лише тоді fix-mode стає
доступним у скілі за замовчуванням.

**Acceptance:** DR-01/03/07/08/09/10/11 закриті тестами; e2e зелений; один
slice реально приземлений у пілоті через гілку.

## Фаза 6 — Хвости (S)

1. `docs/ADR.md` — канонічний ADR-лог (перші записи: ADR-008/012 retired у
   removal; далі — всі id, на які посилається код).
2. Перейменувати ADR-011 «review-chain» (колізія з downstream-скілом
   `codex-chain`).
3. `docs/ADOPTION.md` (знімає onboarding gate з CLAUDE.md) + свідоме ADR-
   рішення: build-on-demand dist проти закоміченого dependency-free бандла
   (закомічений прибрав би bootstrap/stamp-механіку і хвилини `npm ci` на
   кожен бамп піна — trade-off вирішити тут, не за замовчуванням).

## Порядок і залежності

Фаза 1 → (2, 3, 4 — незалежні, будь-який порядок/паралельно) → 5 → 6
(6 можна будь-коли після 1; 5.6/5.8 залежать від L2-адопції review-only в
ai-prompter). Fix-mode (5) свідомо останній з великих: verify-гейт, на який
він спирається, стає змістовнішим після 3 і 4.
