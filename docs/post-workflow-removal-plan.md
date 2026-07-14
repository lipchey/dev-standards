# Post-workflow-removal roadmap

> Статус: затверджено 2026-07-10; Gate P пройдено 2026-07-10 (Codex xhigh,
> 22 знахідки верифіковано й інтегровано нижче).
> Старт виконання: ПІСЛЯ мержа видалення `workflow/` (гілка `ch/workflow-removal`).
> Правило виконання: кожна фаза — окрема сесія з low-level планом і Gate P
> (`codex-plan-review`) перед диспатчем; Gate C (`codex-chain`) після коду.
> Крос-репо правило (усі фази, що міняють і ядро, і пілот): зміна йде
> атомарним циклом core green → push → pin bump → bootstrap/stamp → конфіг
> пілота (див. «dev-standards consumer rules» у глобальному CLAUDE.md);
> rollback відновлює пін І маніфест разом.
> Effort: S ≈ ≤0.5 сесії, M ≈ 1 сесія, L ≈ кілька сесій.

## Передумови (мають бути істинними до старту)

- [ ] `workflow/` видалено з main; тести зелені (~299 після видалення).
- [ ] deep-review більше не імпортує з `workflow/` (4 символи підняті в
      `deep-review/` або `runner/`: createSecretScanner, sanitizeFeatureSlug +
      SlugError, defaultFeatureWorktree, PLANNING_FILE_NAME).
- [ ] Пін ai-prompter бампнуто на removal-SHA (Фаза A removal-плану).

## Фаза 1 — Ядро самоверифіковне (S) — INT-01, INT-02

1. Bootstrap для чистого клону: `npm run bootstrap` (= `npm ci && npm run
   build`); порядок — збірка ПЕРЕД першим self-verify (стара/відсутня
   збірка не має оркеструвати перший прогін); README-крок
   «clone → bootstrap → ./verify».
2. Активувати CI: `ci/workflows/quality.yml` → `.github/workflows/quality.yml`,
   `<base-branch>` = `main`. ОБОВ'ЯЗКОВО: обидва джоби зараз роблять лише
   `npm ci` перед `./verify` — з gitignored `dist/` verify впаде з 127;
   замінити install-крок на bootstrap (або додати build) в обох джобах.
3. Власний `quality.json` ядра: `fast` зараз ганяє лише runner-tests без
   typecheck — порушує guide-правило «auto-тіри typed workspace мусять
   містити typecheck»; додати typecheck у fast; після видалення workflow
   переконатися, що deep-review-сьюта лишилась у full.

**Acceptance:** чистий клон → bootstrap → `./verify --full` зелений локально
і в Actions; fast містить typecheck.

## Фаза 2 — Видалити генератор skill-wrappers (S)

Після видалення workflow виживає один скіл (`deep-review-refactor`) — 648 LOC
`runner/src/generate-skill-wrappers.ts` + ~60 тестів обслуговують генерацію,
яка більше не потрібна.

1. Повний sweep посилань (без нього ламається build): entrypoint у
   `package.json` build-рядку (~:11), test-глоби генераторних тестів
   (`generate-skill-wrappers.test.ts`, генераторна частина
   `standards-sync.test.ts`), `tools/standards-sync` (вимагає
   `runner/dist/generate-skill-wrappers.mjs`), README-згадки
   `standards-sync --check`, зачистка stale `dist/`-бандла, бутстрапи ядра
   і пілота.
2. Wrapper-и вижившого скіла (`.agents/skills/`, `.claude/skills/` у
   консюмері) закомітити статично. Замість генератора — маленький
   статичний контракт-тест: frontmatter wrapper-а валідний, вказівник
   резолвиться в канонічне тіло, дрейфу нема (зберігає корисний інваріант
   без 648 LOC).
3. `tools/standards-sync` звузити до manifest-валідації (або видалити, якщо
   `validate-quality-manifest` CLI покриває).
4. Оновити ADR-003/010: канонічне тіло + статичний вказівник; генерація
   скасована.

**Acceptance:** генератор-коду нема, build/тести зелені, контракт-тест
wrapper-ів зелений, wrapper-и в пілоті статичні.

## Фаза 3 — Детерміністичні аналізатори в тірах (M)

Найдешевший важіль якості AI-генерованого коду.

> Reality-sync 2026-07-14 (N2): передумова «у пілота нема жодної залежності/
> конфігурації аналізаторів» ЗАСТАРІЛА. Пілот (ai-prompter, pin v0.11.1) уже
> проведений САМ (`quality.json` — легальна поверхня тюнінгу консюмера), тож
> кроки 3.1–3.5 виконані пілотом; що лишалось — core-сторона — виконано N2.

1. Передумови в пілоті — **ВИКОНАНО пілотом:** ESLint ^9 devDep + flat
   `eslint.config.js` + `typed_eslint_in_precommit: true`; knip ^5 + `knip.json`;
   coverage-provider `@vitest/coverage-v8` + JSON-репортер → `.artifacts/coverage`
   (для Фази 4.2); gitleaks через `.tools/gitleaks` (checksum-інсталер).
2. Філесети — **ВИКОНАНО пілотом:** додано `git_staged`-філесети (`staged_ts`,
   `staged_site_ts`, `manifests_staged`, `staged_format`); чек `eslint-staged`
   скоупиться `{files:staged_ts}`.
3. Бюджети — **ВИКОНАНО пілотом:** рекалібровано staged 90s / fast 215s /
   full 380s (валідаторне правило `sum(timeout_seconds) ≤ бюджет тіра` зелене).
4. Розкладка — **ВИКОНАНО пілотом:** `eslint-staged` у staged, `eslint` у
   fast+full; `knip` (report-only) і `gitleaks` (report-only) у full. Нові чеки
   заходять `mode: report-only` → blocking СТРОГО за правилом `docs/CALIBRATION.md`.
5. Точка енфорсменту — **ВИРІШЕНА:** pre-push → `--full`; консюмерський CI
   (`verify.yml`) ганяє full на PR і push (gitleaks-крок blocking). Питання
   «full ніхто не ганяє автоматично» закрите.
6. Baselines/ratchets НЕ реалізовувати, поки не з'явиться перший report-only
   чек, якому реально потрібен baseline (YAGNI — слот у схемі вже є).

**Лишалось і виконано N2 (core-сторона):** ядро себе не лінтило і не мало knip —
додано core-self-lint (`eslint.config.js`, чек `eslint` у fast+full, report-only)
+ матеріалізація knip (devDep + `knip.json` + full-tier чек, report-only).
Рішення ESLint 9-vs-10: **лишаємось на 9** — `eslint-plugin-jsx-a11y` (latest
6.10.2, peer ≤^9) і `eslint-plugin-react-hooks@6` (peer ≤^9; ^10 лише в 7.x)
блокують 10; попутно peerDep-чесність (`">=9.38.0"` → `"^9.38.0"`).

**Acceptance:** кожен аналізатор ДОКАЗОВО спавниться (запис у
`reports/quality/`), хуки вкладаються в бюджети, флип report-only → blocking —
лише за правилом `docs/CALIBRATION.md` (dispositioned real catch + нуль
операційного шуму).

## Фаза 4 — Enforcement «новий код = нові тести» (M)

Мета: агенти пишуть тести паралельно з кодом, і тести додають цінність, а не
масу. Три рівні — два механічні + один judgment. Глобальний %-поріг покриття
свідомо НЕ вводиться ніколи — саме він продукує тести-заради-тестів.

### 4.1 Companion-tests check у staged (S→M)

`tools/check-companion-tests.mjs` у ядрі — аналізатор УЖЕ реалізований і
покритий тестами (`tests/tools/check-companion-tests.test.ts`): staged diff
додає/змінює файли під src-глобами, а серед staged нема жодного тест-файла →
fail з підказкою; `skip_if_empty` по src-філесету (не стріляє на doc-only
коміти). ПРОВОДКА — ВИКОНАНА пілотом (reality-sync 2026-07-14, N2): чек
`companion-tests` живе в staged-тірі пілота (bypassable, op-exit `[2]`, 5s).
Bypass-семантика (передумова) ВИКОНАНА: `runner/src/exec.ts:204-206` читає
непорожній `DS_BYPASS_REASON` і повертає `status:'bypassed'` + `reason`; звіт
персистить повний `CheckResult`, тож reason зберігається цілим
(`report.ts:18-20`); 7 тестів у `tests/runner/exec.bypass.test.ts`.
Статус 4.1: tool done, wiring done (пілот), hardening done (N3 2026-07-14):
`DS_BYPASS_REASON` санітизується в точці інгесту (`runner/src/redact.ts`,
redact→cap 200) — обидва sink-и (звіт `report.ts`, телеметрія `telemetry.ts`)
отримують уже санітизоване значення; телеметрійний cap (той самий
`BYPASS_REASON_MAX`) лишається sink-side defense-in-depth. Редакція —
СВІДОМО best-effort deny-list патернів (детермінований, dep-free, НЕ
gitleaks-спавн: report-write не має залежати від доступності зовнішнього
бінарника), тому правило «keep no secrets in DS_BYPASS_REASON» лишається
чинним. Лишилось: калібрування (флип — лише за docs/CALIBRATION.md).

### 4.2 Diff-coverage у full (M)

`tools/diff-cover.mjs` (dep-free) — аналізатор УЖЕ реалізований і покритий
тестами (`tests/tools/diff-cover.test.ts`): покриття ТІЛЬКИ доданих/змінених
рядків. ПРОВОДКА — ВИКОНАНА пілотом (reality-sync 2026-07-14, N2): продюсер
`npm run test:coverage` (`@vitest/coverage-v8`, JSON-репортер →
`.artifacts/coverage`) і чек `diff-coverage` (report-only, `--threshold 70`)
живуть у full-тірі пілота. Контракт ЗВІРЕНО з фактичною семантикою тула й РАТИФІКОВАНО ЗА ТУЛОМ
(N3 2026-07-14, рішення D1-D4 low-level плану):
- Продюсер: vitest `--coverage` (v8, JSON-репортер) → `.artifacts/coverage`,
  `all: true`, vitest `include`/`exclude` вирівняні з `--include`/`--exclude`
  чека (реконсиляція списків — частина контракту); freshness-guard у тулі
  (`loadCoverage`, mtime ≤ 10 хв) — відсутній/стухлий звіт = гучний fail
  exit 2, ще до git-діфа; НОВИЙ звіт при цьому не пишеться (артефакт
  попереднього успішного рана, якщо був, лишається на місці — exit 2
  ніколи не видаляє старий `diff-coverage.json`).
- Decision table `computeCoverage` (точна семантика, не спрощення):
  (1) файл матчить `--exclude` → скіп (виграє над усім); (2) інакше
  coverage-entry присутній → міряється (`--include` не звіряється);
  (3) інакше файл матчить `--include` → операційний fail exit 2 (місконфіг:
  при `all: true` це досяжно лише розсинхроном include/exclude між
  vitest-конфігом і argv чека — «0%» тихо псував би метрику, loud fail
  виявляє місконфіг; живий доказ: дрейф exclude-шляхів у пілоті
  (`corpus/download.ts`, `**/*.spec.ts`) — виправлений у N3-rollout);
  (4) інакше скіп (не source-файл).
- Base-ref: дефолт `origin/main` (pre-push семантика; PR CI коректний за
  fetch-depth 0). Нерозв'язний base / без merge-base → ОДНА recovery-спроба
  fetch (shallow-клон → `--unshallow`, повний і без depth-ліміту; інакше
  `--deepen=50`; часовий ліміт дає runner-ний `timeout_seconds` чека, не
  тул) → гучний fail (exit 2). ПОРОЖНІЙ діапазон (`rev-list base..HEAD`
  пустий — HEAD не має комітів поза base: HEAD==origin/main або позаду
  нього) = легітимний steady-state → N/A exit 0, звіт ПИШЕТЬСЯ
  (base+headSha — аудит-слід); гучний fail тут був би перманентним
  операційним шумом. N/A-гілка діє лише ПІСЛЯ успішного resolveBase і
  свіжого loadCoverage. CI push `event.before` — ПАРКОВАНО в BACKLOG,
  вирішувати разом із blocking-флипом за CALIBRATION.
- Coverage-вивід confined і прибираний: `.artifacts/` gitignored, vitest
  `clean: true`; запис звіту atomic+confined (`writeConfinedJson`).
- CLI-обгортка закрита real-git тестами (`tests/tools/diff-cover.cli.test.ts`):
  порожній діапазон, нерозв'язний base, stale-coverage-до-rev-list,
  end-to-end вимірювання % з порогом.
Поріг старт 70%; exclude: types, config, generated, glue. `report-only` →
blocking СТРОГО за `docs/CALIBRATION.md`.

### 4.3 Доктрина цінних тестів (S) — judgment-рівень

НЕ плодити дублікат: `core-code-guidelines.md` вже має Tests-розділ —
РОЗШИРИТИ його доктриною нижче (merge-don't-duplicate). Окремий
`testing.md` — лише якщо router-style без дублювання. Активація: engine читає
package template in place; пілот додає лише project-specific extension у
same-named `.claude/review-guides/` overlay, без копії core body.
Ядро доктрини:

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

Stryker в `audit` — лише якщо diff-coverage покаже зелені-але-беззубі тести.

**Acceptance:** 4.1 блокує коміт нового src без тестів у пілоті (і байпас
лишає слід у звіті); 4.2 пише звіт у `reports/quality/` і гучно падає на
нерозв'язній базі; доктрина в заповненому гайді пілота.

## Фаза 5 — Deep-review fix-mode: hardening + shipping (L)

Мета: fix-mode (`commit-slice`) безпечний, коректний і реально підключений.
ПЕРЕДУМОВА: Фаза 7.2 (project-facts контракт) — виконати ДО 5.8, бо
no-touch пілота живиться з project-facts, а fail-open там неприйнятний.
Порядок всередині фази жорсткий: preflight → безпека → коректність →
доставка → e2e → пілот. Закриває DR-01/03/04/05/06/07/08/09/10/11/12 та
INT-04.

### 5.0 Центральний preflight + deadline (M)

Факт коду: `deep_review`-конфіг (`enabled`, `modes`, `budget`, `guides_dir`)
валідується схемою, але рантайм його ІГНОРУЄ (`cli.ts` не читає жодного
поля). Реалізувати один preflight перед select-worktree і КОЖНИМ
fix-вербом: enabled=true, `review-and-refactor` ∈ modes, package-гайди
завантажені in place разом з опційним additive repo overlay, один monotonic
deadline із `budget.seconds`
протягнутий через git-виклики, test-спавни, verify і tree-kill.
Rollback фази: прибрати `review-and-refactor` з `modes` пілота.

### 5.1 Вбити клас DR-03 дизайном (M)

У findings JSON заборонити довільний `test_cmd` argv. СТАРТ: дозволити
ЛИШЕ `test_ref: verify:fast | verify:full` (простіше і достатньо для
пілота). Іменовані чеки — пізніше і тільки як `check:<tier>/<name>`
(імена чеків унікальні лише в межах тіра; `loadConfig()` зараз дропає
tiers — знадобиться окремий резолвер). Виконання через runner-івський
`exec.ts` (shell:false, таймаут від deadline 5.0, group-kill). Розрізняти
інфраструктурний фейл спавну від red-тесту — це різні статуси finding-а.
`findings-io` відхиляє старий формат.

### 5.2 Worktree-proof через run descriptor — DR-01 (M)

«cwd належить worktree» недоказовий із поточного стану, а `branch != base`
заслабкий (base-ідентичність зникає разом із workflow). `select-worktree`
персистить confined run descriptor: run id, canonical root,
git-common-dir/git-dir, точний ref `deep-review/<slug>`, base ref+SHA,
initial HEAD. `commit-slice`/`verify`/`handoff` вимагають точної
ідентичності з дескриптором перед будь-якою мутацією; розбіжність —
відмова з machine-error, нічого не мутовано.

### 5.3 Confinement записів + чесний secret-scan — DR-11, DR-12 (S)

Report/findings-записи через патерн `runner/src/report.ts`
(path-confinement + tmp + atomic rename), корінь = `paths.reports`.
Сканер: «відсутній gitleaks» ≠ «чисто» — доступність сканера
представляється окремим станом і є передумовою запису звіту (fail-closed);
e2e-кейси: unavailable / hit / clean.

### 5.4 Коректність станів — DR-07/08/10 (M) — найризиковіший крок фази

Findings schema v2: immutable run id, base SHA, унікальні id знахідок,
verification-запис `{sha, scope, completed_at}`, ревізія/CAS проти
конкурентного read-modify-write. `classify` не перезаписує термінальні
статуси. `report` рендерить ПОВНІ секції Pending та Invalid (id, локація,
титул) — не лише лічильники; звіт із pending позначений як неповний.
Реконсиляція після крешу: trailer-scan (`Deep-Review-Slice: <id>`)
обмежений ancestry поточного рана (не всім лог-графом). v1-файли:
migrate або explicit regenerate-only.

### 5.5 Handoff gate — DR-09 (S)

`handoff` відмовляє, поки не виконано ВСЕ: всі findings термінальні (у
пілоті — жодного `invalid`) ∧ verify зелений із `verified_sha == HEAD` у
v2-записі ∧ worktree чистий.

### 5.6 Shipping — INT-04 (M)

`build:deep-review` у bootstrap консюмера; шим `deep-review` у корені
консюмера (аналог `verify`, зі stamp-guard); блок `deep_review` заповнений;
скіл `deep-review-refactor` wired на CLI-верби (+ виправити в тілі скіла
шлях `project-facts.md` → канонічний `.claude/project-facts.md`, як в
енджині). Окремий факт: dedicated worktree консюмера з `git worktree add`
НЕ отримує ні checked-out submodule (gitlink), ні gitignored `dist/`, ні
`node_modules` — шими і pre-commit hook там мертві. Рішення: бутстрап
worktree під deadline або SHA-keyed shared build cache з
freshness-перевіркою (guide-правило «build-on-demand артефакт → stamp +
freshness»).

### 5.7 Real-git e2e (M)

`tests/deep-review-e2e/` на тимчасовому git-репо БЕЗ мок-сімів (root cause
§6.1). Матриця (включно з DR-04/05/06): happy slice-коміт; out-of-slice
dirty → відмова; **unstaged** запис у no-touch → відмова (не лише staged);
red test → відкат ПОВНОЇ дельти index+worktree (snapshot/restore, не лише
named slice paths — інакше лишається resídue типу coverage/lcov); staged
new-file при RED; timeout + вбиті нащадки; spawn-fail ≠ red; запуск на
main → відмова; handoff із pending → відмова; e2e консюмер-worktree з
реальним submodule + pre-commit hook + stale stamp.

### 5.8 Пілот (S)

Передумова: 7.2 виконано (project-facts у пілоті, `vendor/dev-standards`
у no-touch). На ai-prompter: повний review-only цикл → fix-mode на ОДНІЙ
низькоризиковій P2-знахідці → людське рев'ю диффа → лише тоді fix-mode
доступний у скілі за замовчуванням.

**Acceptance:** DR-01/03…12 закриті тестами; e2e зелений (вкл. worktree-
bootstrap кейс); один slice реально приземлений у пілоті через гілку.

## Фаза 6 — Хвости + зняття onboarding gate (M)

1. `docs/ADR.md` — канонічний ADR-лог (перші записи: ADR-008/012 retired у
   removal; далі — всі id, на які посилається код).
2. Перейменувати ADR-011 «review-chain» (колізія зі скілом `codex-chain`).
3. Повна диспозиція `DEEP_REVIEW_FINDINGS.md` (передумова зняття gate —
   зараз файл untracked, а roadmap адресує лише частину знахідок): кожен
   finding → fixed / obsolete-after-removal / rejected+evidence /
   phase-N / BACKLOG; диспозицію закомітити.
4. `docs/ADOPTION.md` (знімає onboarding gate з CLAUDE.md). Адопшн ОБОВʼЯЗКОВО
   включає авто-сідинг чотирьох instance docs: (а) виклик
   `vendor/dev-standards/scripts/seed-review-guides.sh <repo-root>` з
   консюмерського `ds-bootstrap.sh` — ПІСЛЯ submodule update + build (сабмодуль
   не ініціалізований → bootstrap падає гучно раніше за сідер, тож порядок
   зафіксований); (б) fast-tier check у `quality.json`
   `{"argv":["vendor/dev-standards/scripts/seed-review-guides.sh",".","--check"]}`
   — детермінований гейт наявності лише instance docs. Сім generic guides engine
   читає безпосередньо з package; repo володіє тільки additive overlay; (в)
   рядок-правило в консюмерському CLAUDE.md: після
   завершення фічі агент автоматично ПРОПОНУЄ `deep-review-refactor` по
   змінах бранчі (скоуп = дифф проти бази, не весь репо); запуск лише за
   згодою користувача (контракт офера — у тілі скіла, «When to use»).
5. Рішення щодо артефактів: ДЕФОЛТ — ратифікувати чинний контракт
   build-on-demand + `.built-from`-stamp (він уже реалізований і
   перевірений); committed-bundles розглядати лише з повним планом
   міграції шимів/ignore/bootstrap/CI і rollback-ом.
   ДОДАТКОВО (Gate P Фази 1, 2026-07-10): портувати freshness-гард у ЯДЕРНИЙ
   `verify`-шим (`tools/standards-sync` видалено у Фазі 2; зараз шим перевіряє
   лише *існування* бандла — guide-правило «build-on-demand артефакт → stamp + freshness»
   порушено в ядрі; CI безпечний, бо bootstrap білдить щоразу; ризик — локальна
   ядерна розробка). SHA-стамп консюмера тут НЕ годиться (активна ядерна
   розробка міняє HEAD щокоміта + лишає uncommitted-правки) — потрібен
   content-fingerprint інпутів білда, не revision-стамп.

## Фаза 7 — Контракт per-project тюнінгу (M)

Мета: модифікація/файнтюн dev-standards під конкретний проект — явний,
задокументований механізм. Сьогодні продумано частково.

### Що вже є (зафіксувати в ADOPTION.md як три легальні поверхні тюнінгу)

1. **`quality.json`** — повністю проектний конфіг: стек, тіри/чеки/бюджети,
   філесети, policy, `deep_review` блок (schema-validated).
2. **`.claude/review-guides/`** — опційний project overlay: generic guide bodies
   мають єдине джерело в package `agents/review-guide-templates/` і читаються
   in place. Same-named overlay лише additive-розширює package guide; додатковий
   `.md` додає project-only guide. `seed-review-guides.sh` сідає тільки чотири
   instance docs, а відсутній/порожній overlay валідний.
3. **No-touch floor** — extend-only union: проект може додати зони, звузити
   BASELINE не може.

### Чого нема — додати

1. **Модель узгодження — additive-only, БЕЗ override (S).** Гайди в
   trust-моделі гейтів — additive-only checklist data: правило може лише
   додати перевірку, ніколи не скасувати чужу (INDEX глобальних гайдів +
   обидва gate-скіли явно ігнорують waivers). Тому «precedence
   project > global > core» як runtime-механізм НЕ вводити. Натомість:
   проектна специфіка виражається через project-facts (applicability/
   кондиційність: тип репо вмикає strong/light/none у гайдах); пряма
   контрадикція проектного правила з core-template → human reconciliation
   через `inbox/review-promotions.md`, не автоматика. Маркер
   `> deviates-from-core: <причина>` у проектному гайді — ДОКУМЕНТАЦІЯ
   людського рішення (щоб promotion-сесія не «зливала» його назад у core),
   не механізм скасування правил.
2. **Специфікувати `project-facts.md` (S).** Канонічний шлях =
   `.claude/project-facts.md` (дефолт енджина; текст скіла виправити — він
   каже root `project-facts.md`). Шаблон `agents/project-facts-template.md`:
   layer DAG, домені терміни, `## No-Touch Zones`, тип репо для
   кондиційності гайдів. Політика читання: у МУТУЮЧОМУ режимі (fix-mode)
   відсутній/нечитабельний/неспарсений facts = fail-closed (відмова), не
   мовчазний fallback на baseline; ref — confined/realpath. У пілоті
   створити файл і додати `vendor/dev-standards/**` у no-touch.
3. **Політика скілів: не форкати (S).** Канонічні тіла скілів єдині для
   всіх проектів (ADR-003); проектна специфіка ВИКЛЮЧНО через guides +
   project-facts. Потрібна поведінка, якої guide-рівень не дає → core-зміна
   через fix-upstream цикл (за потреби — опційний config-прапор у
   quality.json), НЕ локальний форк тіла скіла. Зафіксувати в CLAUDE.md
   ядра + ADOPTION.md.

**Acceptance:** ADOPTION.md має розділ «Per-project tuning» (3 поверхні +
3 правила); `project-facts-template.md` існує; additive-only модель і
deviation-маркер описані; шлях project-facts узгоджений скрізь; у пілоті
жоден проектний файл не дублює тіло core-скіла.

## Порядок і залежності

Фаза 1 → (2, 3, 4 — незалежні; 4.2 залежить від coverage-provider у 3.1)
→ 7.2 → 5 → 6, 7.1/7.3 (6 і 7 можна будь-коли після 1; природно робити
разом — обидві живлять ADOPTION.md; 5.6/5.8 залежать від L2-адопції
review-only в ai-prompter). Fix-mode (5) свідомо останній з великих:
verify-гейт, на який він спирається, стає змістовнішим після 3 і 4.
