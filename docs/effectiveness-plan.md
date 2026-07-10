# План: телеметрія ефективності + петля файнтюну (Фаза 8)

Статус: затверджено 2026-07-10. Gate P пройдено (Codex xhigh + власний
прохід; 11 знахідок верифіковано, план виправлено).
Доповнює `post-workflow-removal-plan.md` (не змінює Фази 1–7).

## Мета

1. **Виміряти, що dev-standards реально ловить.** Сьогодні кожен catch-event
   народжується в `runner/src/exec.ts runCheck` і вмирає: stdout + один
   gitignored `reports/quality/verify-<scope>.json`, який перезаписується
   кожним раном. Історії нема — оцінити ефективність неможливо.
2. **Замкнути петлю для пропусків.** Скелет уже існує (promotions inbox +
   review-guides capture у gate-скілах), але нема формального сигналу
   «баг пройшов повз гейт, який мав його зловити», нема метрик і нема
   регулярного циклу, що перетворює дані на рішення (flip/prune/tune).

## Дизайн-рішення

### 1. Sink: append-only JSONL у домашній директорії

`~/.local/share/dev-standards/events.jsonl` — один файл на машину, всі
консюмери (поле `repo` вже є в RunnerReport).

- Переживає re-clone репо (gitignored per-repo файл — ні).
- Нуль шуму в комітах (git-tracked лог — постійний merge/diff-шум).
- Агрегація по всіх консюмерах безкоштовна.
- **Ініціалізація обовʼязкова**: перший запис створює директорію
  (`mkdirSync recursive`, 0700) і файл (0600) через `os.homedir()` —
  `appendFileSync` сам батьківські директорії не створює, а «fail-open без
  init» на свіжій машині = вічна мовчазна втрата даних. Тест: два appends
  зі стану «батьківської директорії не існує».
- `--doctor` перевіряє writability sink-а — щоб зламаний sink було видно,
  а не лише stderr-ворнінг, який ніхто не читає.
- Один env-кноб `DS_TELEMETRY_PATH`: unset = дефолтний шлях;
  `off` = вимкнено; інше = кастомний шлях. Контракт задокументувати в
  README (env-секція).

Відхилені альтернативи: git-tracked файл (шум), SQLite (залежність без
потреби), Directus/n8n-експорт (передчасно; JSONL зливається туди пізніше
одним скриптом — extension point, не v1), append у verify-шимі (шим робить
`exec` — нема post-step; дублюється per-consumer; нема тестів).

### 2. Подія = один JSONL-рядок на ран verify

Існуючий масив `results` + git-контекст + метадані:

```json
{"v":1,"startedAt":"…","finishedAt":"…","repo":"ai-prompter",
 "scope":"staged","branch":"main","head_sha":"…","exit":1,
 "aborted":false,"results":[{"name":"companion-tests","tier":"staged",
 "status":"fail","exitCode":1,"durationMs":312,"mode":"blocking"}]}
```

- **Exactly-once finalization seam**, незалежний від запису звіту:
  телеметрія пишеться в одному місці (`finally`-рівень `runTier`/`main`),
  ПІСЛЯ обчислення exit-рішення (`results.some(isBlockingResult)`), і має
  спрацювати й на abort-шляху (deadline/помилка → `aborted:true`,
  часткові results). Збій запису ЗВІТУ не гасить телеметрію, і навпаки.
  Сам «поруч із emitReport» недостатній: RunnerReport не має ні exit, ні
  git-контексту, а нормальний emitReport відбувається до обчислення exit.
- **Fail-open для самої телеметрії**: збій запису — stderr-ворнінг, ніколи
  не блокує тір/комміт (юніт-тест обовʼязковий). Постійно зламаний sink
  ловиться doctor-чеком (§1).
- **Git-контекст best-effort**: `runner/src/git.ts` хелперів branch/sha не
  має — додаються два виклики з малим фіксованим timeout, nullable,
  non-blocking: не-git директорія / detached HEAD / збій git → `null`,
  ран не страждає (сьогодні порожньо-філесетний ран у не-git tmp-дирі
  проходить — так має лишитись; тест на всі чотири кейси).
- Один `appendFileSync` = один рядок; конкурентні рани безпечні на
  практиці, а стійкість до обірваного рядка — на боці reader-а (§4).
- **Вміст подій**: імена чеків, статуси, exit-коди, час — плюс ОДНЕ
  довільне текстове поле: `reason` (bypass-причина з `DS_BYPASS_REASON`,
  спавн-errno). Це env-текст від людини: кап довжини (~200 симв.),
  конвенція «без секретів» у README, права 0700/0600 (§1). Формулювання
  «жодного вмісту коду» — некоректне, не вживати.

### 3. Пререквізит: operational-error channel (inbox, рядок 44)

Без нього exit-2 diff-cover («stale coverage», поломка тула) рахується як
«спійманий дефект» і бруднить статистику; це й так пререквізит
запланованого фліпу в blocking. Контракт — **явний opt-in per check**, не
глобальна конвенція (семантика exit 2 різна між тулами: в ESLint це
operational, деінде — findings):

- `operational_exit_codes?: number[]` у `Check`: оголошений код →
  `status:'error'` (unbypassable, блокує незалежно від mode, як спавн-збій);
  неоголошений nonzero — як сьогодні `fail`/`bypassed`. Обидва напрямки —
  тестами (оголошений 2 → error; неоголошений 2 → fail).
- Зачіпає: `types.ts`, схему (`additionalProperties:false`!), валідатор,
  конформанс-тести (вони асертять ТОЧНИЙ набір полів чека —
  `validate.conformance.test.ts`), пілотний `quality.json`
  (diff-coverage: `[2]`).
- `check-companion-tests.mjs` не має top-level catch — внутрішній throw
  зараз виходить як 1 (= finding). Додати catch → окремий operational
  exit code, оголошений у манифесті.
- Rollback: pin revert + manifest revert (двохкроковий, задокументувати в
  коміті кроку). Найризиковіший крок фази — міняє enforcement boundary;
  pilot-first, обидва напрямки класифікації закриті тестами.

### 4. Аналіз: `tools/quality-stats.mjs` (dep-free, як інші tools)

Читає JSONL, віддає per-`(repo, tier, check, branch)` — ключ повний, бо
файл глобальний (спільний для всіх репо), а `eslint` у пілоті живе і в
fast, і в full:

- runs, fails, **catch-candidates** (fail → pass того ж ключа в наступному
  рані), bypass-и (з причинами), operational errors, timeouts, p50
  тривалість. `skipped` виключається зі знаменників (runs/duration);
  timeout/error рахуються як operational noise, не як catches.
- catch-candidate — **евристика, не доказ** (pass міг статися через
  unstage, а не фікс): тул віддає КАНДИДАТІВ, диспозицію (real catch /
  false positive / noise) робить людина в калібрувальній сесії (§6).
- **Рекомендації = теж кандидати**: report-only чек з ≥1 real catch
  (за диспозицією) і 0 operational noise за N днів → «flip у blocking»;
  чек з 0 fails за M днів → «кандидат на prune» — АЛЕ prune тесто- чи
  coverage-гейта вимагає mutation/replay-доказу, що вцілілі гейти ловлять
  конкретні мутації («never failed» ≠ доказ — testing guide). Дефолти:
  N=7, M=30 (прапори `--since`/`--prune-window`).
- Robustness (тестований контракт): обірваний останній рядок, битий
  рядок у середині, непідтримуваний `v`, порожній файл — скіпаються і
  РАХУЮТЬСЯ (лічильник malformed у виводі); межі вікон.

Запуск: `node vendor/dev-standards/tools/quality-stats.mjs` (без нових
прапорів у раннері — YAGNI).

### 5. Miss ledger: `.agents/gate-misses.md` у консюмері

Формальний сигнал пропуску. Міс = дефект, який детермінований чек verify
міг/мав зловити, але він дійшов до пізнішої стадії (Gate C, deep-review,
рантайм, юзер-репорт).

Формат — append-only рядки (лічильні grep-ом, як inbox):

```text
- [ ] <date> <стадія-де-знайшли> - <one-line дефект> (клас: check-missing |
  too-narrow | report-only-ignored | wrong-tier) → <маршрут фіксу>
```

Capture-тригери (v1 покриває ВСІ стадії з визначення, не лише Gate C):

- **Gate C**: амендмент `codex-chain` Step 4.5 (глобальний скіл): для
  кожного VALID finding — питання «чи мав детермінований гейт це
  зловити?» → так = рядок у ledger з класом і маршрутом. У review-only
  сесії (без права мутації) скіл віддає структурованого кандидата в
  репорті — append робить основна сесія.
- **Рантайм/юзер-репорт**: правило в ledger-шаблоні — будь-яка сесія, що
  фіксить рантайм-баг, додає рядок (ручний тригер; амендмент
  systematic-debugging — v1.1, не блокер).

Маршрутизація і **закриття** (за trust-моделлю Фази 7):

- consumer-фікс (quality.json tweak) — чекбокс закривається ТІЛЬКИ з
  доказом, що гейт тепер ловить цей пропуск: прогін чека проти
  ЗБЕРЕЖЕНОГО offending-стану — він проходив (green) до фіксу гейта (це і
  є міс) і мусить падати (red) після; виправлений поточний стан лишається
  green — дзеркало guide-правила про regression-тест для багфіксу;
- guide-правило (недетермінований фікс) — закривається з маркером
  `(nondeterministic-fix: guide)`, щоб stats відрізняв детерміновані
  закриття від суддівських;
- core-фікс (новий analyzer, зміна раннера/схеми) — рядок дублюється в
  `inbox/review-promotions.md`, у ledger — посилання. Формат inbox
  вимагає `repo#pr + comment-url`, які в рантайм-місів відсутні (і
  існуючі pending-рядки вже відхиляються від формату) — узагальнити
  провенанс-поле до `<source-ref>` (одна правка в шапці inbox,
  core-сесія, разом з 8.1).

dev-standards шипить шаблон `agents/gate-misses-template.md`; консюмер
копіює при онбордингу (пілот — вручну в 8.4).

### 6. Калібрувальна сесія: `docs/CALIBRATION.md` (плейбук)

Регулярна мікро-сесія (раз на 1–2 тижні, або перед будь-яким flip):

1. `quality-stats` по накопиченому JSONL;
2. **диспозиція catch-candidates** (real / false positive / noise) — людське
   рішення, яке перетворює кандидатів на метрики;
3. читання gate-misses ledger + pending inbox;
4. рішення: flip report-only→blocking / prune (з mutation-доказом per §4) /
   tune quality.json / промоушн inbox-пунктів (core-частина — в core-сесії);
5. короткий підсумок (дата, рішення, підстава-цифри) — append у кінець
   CALIBRATION.md.

**Перша ітерація = уже запланований flip eslint/knip/diff-coverage**: замість
рішення «на око» flip відбувається на тижневих даних телеметрії.

## Метрики ефективності (визначення)

- **Catch rate**: disposition-підтверджені catches / тиждень, per check і
  per tier (кандидати — проміжний сигнал).
- **Escape rate**: рядки gate-misses / тиждень, за класами.
- **Noise**: хронічні report-only fails без фіксу + bypass-частота +
  operational errors/timeouts.
- **Cost**: сумарний час verify за день vs кількість catch-ів
  («ціна одного catch у секундах»).
- **Trend**: escape rate до/після кожної калібрувальної сесії — головний
  показник, що петля файнтюну працює.

## Кроки (Фаза 8; розміри S–M)

| Крок | Що | Де | Розмір |
|------|----|----|--------|
| 8.1 | Operational-error channel: `operational_exit_codes` (схема+валідатор+конформанс+обидва тули+пілотний манифест+rollback-нотатка) + узагальнення провенанс-поля inbox | core + пілот | M |
| 8.2 | Telemetry: sink init (mkdir/0700/0600) + finalization seam + git-контекст best-effort + `DS_TELEMETRY_PATH` + doctor-чек + тести (fail-open, fresh-machine, abort-шлях, non-git) + test-suite/CI default-off (package-level test env + явний env у спавнах fixtures) | core | M |
| 8.3 | `tools/quality-stats.mjs` + тести (фікстурний JSONL, malformed/version/вікна) | core | M |
| 8.4 | `gate-misses-template.md` (вкл. runtime-правило і правила закриття) + копія в пілот + амендмент codex-chain Step 4.5 | core + пілот + глобальні скіли | S |
| 8.5 | `docs/CALIBRATION.md` + перша калібрувальна сесія (= flip-рішення на даних) | core + пілот | S |
| 8.6 | `tools/quality-report.mjs` — self-contained HTML-дашборд над тим самим sink (model + client-render + фільтри + stacked byDay + checks/catches) + тести | core | M |

Порядок: **8.1 → 8.2 → 8.4 — усі ДО observation-тижня** (телеметрія без
8.1 бруднить статистику, а misses мають накопичуватись тим самим тижнем);
8.3 будь-коли після 8.2; 8.5 після ~тижня накопичених даних. Кожен
core-крок — стандартний цикл: fix upstream → push+tag → pin bump →
bootstrap → `./verify --fast`.

### 8.6 — Visual report (`tools/quality-report.mjs`)

Human-friendly шар над тим самим `events.jsonl`: один self-contained HTML —
без сервера, npm-депів, CDN (відкривається офлайн, переживає re-clone). Уся
агрегація (вікна, catch-adjacency, flip/prune, run-outcome, latestMode)
рахується в Node через експортовані чисті фн `quality-stats`; вбудований
клієнтський JS лише фільтрує slim per-run рядки і сумує — цифри не розходяться
з текстовим звітом. `buildReportModel` пре-фільтрує події у вікно
(`cutoff <= startedAt <= now`) ДО `aggregate`; run-outcome береться з
persisted `exit`/`aborted` (`pass`/`blocked`/`aborted`), ніколи не з
re-derived block-rule. Ін'єкція знешкоджена (кожен `<` серіалізується як
JS-escape, а не голий символ; вставка в DOM лише через `textContent`);
`--out` відмовляється перетерти sink і пише
атомарно. Flip/prune-бейджі рахуються по КАЛІБРУВАЛЬНИХ вікнах (7д/30д,
імпортовані константи quality-stats), а не по embed-вікну `--days` — дашборд
ніколи не суперечить текстовому звіту щодо кандидатності. CLI:
`node tools/quality-report.mjs --path <events.jsonl>
--out <report.html> [--days N] [--open]`.

## Acceptance (Фаза 8 закрита, коли)

- кожен ран `./verify` додає рядок у events.jsonl, ВКЛЮЧНО на свіжій
  машині (без існуючої директорії) і на abort-шляху; повторні рани не
  перетирають історію; `DS_TELEMETRY_PATH=off` вимикає запис;
- збій запису телеметрії не блокує тір (юніт-тест); `npm test` і CI НЕ
  пишуть у реальний events.jsonl (перевірено тестом env-контракту);
- оголошений operational exit code → unbypassable `error`; неоголошений —
  `fail`, як сьогодні (обидва напрямки тестами);
- `quality-stats` на реальних даних пілота віддає per-key таблицю,
  malformed-лічильник і flip-КАНДИДАТІВ;
- міс, зафіксований будь-яким тригером, має клас і маршрут; закриття
  consumer-міса має red→green доказ; core-міс має дзеркальний рядок в
  inbox;
- CALIBRATION.md існує; перше flip-рішення прийнято з посиланням на цифри
  і диспозицію кандидатів.
- `quality-report.mjs` рендерить self-contained HTML з того самого sink;
  flip/prune-бейджі збігаються з вердиктами `quality-stats` (калібрувальні
  вікна 7д/30д незалежно від `--days`).

## Out of scope (v1)

Візуалізації понад self-contained HTML-звіт кроку 8.6 (сервер, live-reload,
тренди глибші за byDay); експорт у Directus/n8n (extension point — JSONL);
автоматичне unlearning правил (лишається challenge-only per trust-модель);
телеметрія deep-review (уже має per-day markdown-звіти) і скілових
capture-івентів (видно в git-історії гайдів); амендмент
systematic-debugging (v1.1).
