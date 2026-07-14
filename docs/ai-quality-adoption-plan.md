# AI-quality adoption plan (ресерч 2026-07-14)

> Статус: затверджено до виконання; Gate P пройдено 2026-07-14 (Codex xhigh,
> 10 знахідок: 8 VALID + 2 PARTIAL — інтегровано нижче; власний незалежний
> прохід — 4 знахідки, інтегровано).
> Джерело: веб-ресерч «інструменти/методології якісного коду з АІ, 2025-2026»
> (107 знахідок → 103 верифіковано adversarial fact-check-ом → 3 лінзи
> проектної придатності). Фільтр відбору: максимальна ефективність, не
> повнота — включено лише те, що реально додає якість dev-standards.
> Зв'язок з `docs/post-workflow-removal-plan.md`: НЕ замінює його. Фази 3-4
> роадмапу ресерч підтвердив як найвищий важіль — цей план додає лише
> ресерч-народжені дельти і фіксує корекцію застарілих фактів роадмапу.
> Правило виконання: кожна фаза — окрема сесія з low-level планом і Gate P
> перед диспатчем; Gate C після коду. Нові чеки заходять `report-only` →
> blocking СТРОГО за правилом CALIBRATION.md (≥1 dispositioned real catch +
> нуль операційного шуму — НЕ «тихий тиждень»).
> Effort: S ≈ ≤0.5 сесії, M ≈ 1 сесія.

## Головний висновок ресерчу (чому план такий малий)

dev-standards уже реалізує консенсус 2025-2026: детермінований floor
(verify-тіри) + суто дорадче імовірнісне рев'ю (Codex Gates / deep-review)
+ калібрувальний eval-loop на власних гейтах. Більшість каталогу — вже
покрито або свідомо поза скоупом. Реальна нова прогалина одна
(dependency-hallucination gate); решта цінності — дотягнути вже
спроектовану проводку Фаз 3-4 і кілька дешевих doc/конфіг-рядків.

## Блок 0 — Статус-матриця роадмапу: виправити застарілі факти (S)

Верифіковано 2026-07-14 — роадмап відстав від кодової бази в трьох місцях:

1. **Bypass-семантика (передумова 4.1) — ВИКОНАНА:**
   `runner/src/exec.ts:204-206` читає непорожній `DS_BYPASS_REASON` і
   повертає `status:'bypassed'` + `reason`; звіт персистить повний reason
   (`report.ts:18-20` серіалізує повний `CheckResult`), телеметрія — з
   обрізанням до 200 символів; 7 тестів у `tests/runner/exec.bypass.test.ts`.
   У §4.1 замінити блок «УВАГА (залежність)» на позначку виконання.
2. **Інструменти 4.1/4.2 — ВЖЕ ІСНУЮТЬ:** `tools/check-companion-tests.mjs`
   і `tools/diff-cover.mjs` реалізовані й покриті тестами
   (`tests/tools/*`), а роадмап досі описує їх створення. Позначити:
   аналізатори done, лишилась ПРОВОДКА (тіри пілота + coverage-producer
   для 4.2).
3. **Flip-критерій:** формулювання «report-only → blocking після ~тижня без
   шуму» (Фаза 3.4) замінити посиланням на правило CALIBRATION.md
   (dispositioned real catch + нуль операційного шуму) — воно суворіше і
   вже канонічне.

**Acceptance:** роадмап не містить жодного з трьох хибних тверджень;
статус 4.1 = «tool done, wiring pending, без передумов у ядрі».

## Фаза N1 — `check-new-deps.mjs`: dependency-pin / slopsquatting gate (M)

Єдина справжня нова прогалина. Емпірика: ~21.7% open-source-JS АІ-семплів
посилаються на фантомний пакет (USENIX Security 2025); 43% фантомних імен
повторюються між генераціями → пре-реєстровані атаки (slopsquatting).
Захист — механічний гейт, не промпт. `security-review.md` (~рядки 190-193)
уже МАЄ judgment-правила «lockfile + pin + typosquat» — ця фаза механізує
їх (канонічний promotion-шлях: judgment → gate). Найризикованіший крок
плану: false negative зводить гейт нанівець, false positive на pre-commit
привчає до байпасу — тому вхід report-only + інтеграційні тести обов'язкові.

### Контракт (виконавча специфікація)

- **Скоуп v1:** лише npm, lockfile v3, ЯВНА пара маніфест↔lockfile
  (root `package.json` ↔ root `package-lock.json`; npm-workspaces ділять
  root-lockfile). Узагальнене workspace-discovery та pnpm/yarn — НЕ робити,
  поки не з'явиться реальний консюмер з такою конфігурацією.
- **Джерело даних — index-blobs, НІКОЛИ working tree:** staged-вміст через
  `git show :<path>`, база через `git show HEAD:<path>` (fixed argv,
  `shell:false` — патерн `exec.ts`). Unborn HEAD (initial commit) = порожня
  база, не помилка; renames через `--name-status -z -M`; відмінність
  git-фейлу від «файла нема в базі» — обов'язкова.
- **Позитивна граматика специфікацій** для НОВОдоданих deps (allow-list, не
  deny-list — правило security-guide): точний semver | `^`-діапазон |
  `~`-діапазон | `file:vendor/dev-standards`. УСЕ інше — fail: git/URL/
  tarball, `*`, `>=`, `<=`, `>`, `||`, дефіс-діапазони, теги (`latest`),
  shorthand (`1`, `1.2`). Обґрунтування `^`/`~` у allow: жива конвенція
  цього ж репо (15 caret-записів у власному `package.json`) + npm-дефолт;
  реальний pin — lockfile. Суворіший exact-only режим — опційний policy-flag
  у low-level плані, не дефолт.
- **Секції:** `dependencies`, `devDependencies`, `optionalDependencies`;
  `peerDependencies` — виняток (діапазони там легітимний контракт).
- **Lockfile-правила:** (а) вимога staged-lockfile ЛИШЕ коли змінились
  dep-несучі поля — metadata-only правки маніфеста (`scripts`, `engines`,
  `name`, …) проходять без lockfile-дельти (git не може stage-нути
  незмінений файл); (б) кожен новододаний dep має DIRECT-entry у lockfile
  v3 (`packages[""].dependencies/devDependencies…` або workspace-entry) —
  сама наявність `node_modules/<name>` НЕ доказ (false-pass на транзитивному
  пакеті).
- **Non-bypassable:** `DS_BYPASS_REASON` — глобальний для процесу
  (`exec.ts:204`): одна причина, задана для companion-tests, у тому ж рані
  погасила б і supply-chain-знахідку. Тому цей чек `bypassable` НЕ ставити;
  per-check bypass-селектор — окрема runner-зміна, передумова ЯКЩО колись
  знадобиться другий bypassable-чек у тому ж тірі.

### Кроки

1. `tools/check-new-deps.mjs` — dep-free, у стилі сусідніх tools
   (operational exit code 2 для інфра-фейлів: нечитабельний lockfile,
   git-фейл; гучний fail, не мовчазний pass).
2. **Upstream-фікс сідера ДО флипу:** `scripts/seed-eslint-config.sh` пише
   `"eslint": ">=9.38.0"` — офіційний adoption-шлях сам трипнув би гейт;
   замінити на caret-специфікацію (+ тест сідера).
3. Проводка (точні об'єкти — у low-level плані фази, обидва з
   `operational_exit_codes: [2]`, `mode: "report-only"`, `skip_if_empty`
   на новому філесеті маніфестів, `timeout_seconds: 10`):
   - ядро: `fast`-tier (ядро НЕ має `.githooks` — staged-tier там ніким не
     виконується; fast ганяє CI на кожен PR), argv
     `["node","tools/check-new-deps.mjs",…]`;
   - стартери (`templates/consumer/quality.starter.json`): `staged`-tier
     (пре-комміт хук у консюмерів живий), argv через
     `vendor/dev-standards/tools/check-new-deps.mjs`.
4. Тести: unit-матриця — floating/заборонена специфікація fail; git/URL
   fail; dep-несучі поля без staged-lockfile fail; новий dep без
   direct-entry fail (включно з транзитивним false-pass кейсом);
   metadata-only pass; `file:vendor/dev-standards` pass; часткове stage;
   rename; initial commit (unborn HEAD); операційний exit-код. ПЛЮС
   інтеграційний тест через runner на тимчасовому git-репо (патерн
   `tests/deep-review-e2e/`) — unit-тестів тула недостатньо.
5. Пілотний rollout — за крос-репо транзакцією роадмапу: core green → push
   → pin bump → bootstrap/stamp → правка `quality.json` пілота → verify;
   rollback відновлює пін І маніфест разом.

**Acceptance:** чек доказово спавниться на маніфест-коміті в ядрі (fast) і
пілоті (staged) — запис у `reports/quality/`; metadata-only коміт
проходить; повна тест-матриця зелена; сідер більше не продукує
заборонену специфікацію; флип у blocking — лише за CALIBRATION.

## Фаза N2 — виконати Фазу 3 роадмапу (M; без змін плану)

Ресерч підтвердив Фазу 3 як «найдешевший важіль якості АІ-коду» — виконати
як написано. Ресерч-дельти до low-level плану фази:

- ESLint v10 (GA 2026-02) видалив eslintrc — наші пресети вже flat-config,
  але сідер/пресети/README ESLint-9-орієнтовані (`>=9.38.0`, `^9`, `^8`):
  рішення 9-vs-10 приймається у low-level плані ЄДИНИМ sweep-ом
  (package.json, peer-deps, `@eslint/js`, шаблон, README, lockfile, тести
  пресетів) — не точковими правками.
- Пресетний suppression-guard (`no-unlimited-disable` +
  `reportUnusedDisableDirectives`) — це і є галузевий «агент не глушить
  правила заради зеленого діфу»; НЕ додавати нових плагінів заради цього.
- knip досі не існує як devDep/конфіг ніде (верифіковано) — при тому, що
  всі dead-code-згадки гайдів уже вказують на нього як на owning gate.
  Матеріалізація knip — обов'язкова частина фази, інакше посилання
  гайдів — нечесні.
- Опційно (рішення в low-level плані): ESLint-чек і для ЯДРА
  (`quality.json` fast) — зараз ядро себе не лінтить.

## Фаза N3 — виконати Фази 4.1 + 4.2 роадмапу (M)

Порядок (виправлено після Gate P): 4.1 виконується ПІСЛЯ появи
`git_staged`-філесета і рекалібрування staged-бюджету в пілоті (це кроки
Фази 3.2-3.3 → N2), не «одразу після Блоку 0». 4.2 — після
coverage-provider з 3.1. Ресерч-дельта — пріоритет ↑: reward-hacking
виміряний (~29.6% «правдоподібних» агентних патчів поведінково розходяться
зі специфікацією — PatchDiff 2025), тому механічні «нові src ⇒ staged
тест» + diff-coverage — перша лінія проти «зелено, але беззубо».
Глобальний %-поріг покриття, як і в роадмапі, НЕ вводиться.

Hardening перед тим, як пілот почне ПОКЛАДАТИСЯ на bypass (4.1 —
bypassable): reason іде у звіт/телеметрію verbatim, а security-guide
вимагає секрет-скан генерованих звітів перед записом — додати
cap+redact/scan причини на обох sink-ах (малий крок у low-level плані N3).

## Фаза N4 — дешева четвірка: платформа + доктрина (S, одна сесія)

1. **`templates/consumer/github/dependabot.yml`** — weekly, npm ecosystem,
   згруповані minor/patch. Платформа робить роботу; це СВІДОМА заміна
   `npm audit`-чеку в тірах (шумний, транзитивний, мережевий — відхилено).
   Доставка (не лише шаблон): маппінг у `seed-consumer.sh` → консюмерський
   `.github/dependabot.yml` (це НЕ `workflows/` — окремий copy-рядок),
   рядок у `--check`, кейс у `tests/e2e-adoption-kit.sh`, рядок в
   ADOPTION-таблиці «що куди лягає». Існуючі консюмери: разова згадка в
   ADOPTION (copy-if-absent не мігрує вже посіяних).
2. **`docs/ADOPTION.md` — платформні мандати** (по одному рядку):
   консюмери на GitHub вмикають Secret-scanning Push Protection
   (безкоштовний шар ПІД локальним gitleaks-гейтом); GitHub-hosted
   консюмери — CodeQL default setup. Конфіг, не гейти.
3. **`AGENTS.md`-pointer:** однорядковий вказівник (symlink або 3-рядковий
   файл) `AGENTS.md` → `CLAUDE.md` у корені ядра + в консюмерському
   шаблоні. Обґрунтування: звичайний `codex exec` читає AGENTS.md і НЕ
   читає CLAUDE.md — без вказівника Codex-рани поза скілами (де шляхи
   передаються явно) не бачать правил репо. Це вказівник, НЕ друге джерело
   правди — контент не дублюється.
4. **Три doc-промоушени** через `inbox/review-promotions.md` (обробити в
   цій же core-сесії за штатним циклом):
   - `core-code-guidelines.md` §Tests: правило незалежності оракула —
     очікуване значення, згенероване тим самим агентом, що писав код, —
     тавтологія; оракул береться зі специфікації, hand-computed значення
     або незалежного джерела (сигнал тавтології: високий line-coverage +
     низький mutation-score);
   - `docs/CALIBRATION.md`: назвати StrykerJS `--incremental` санкціонованим
     інструментом «mutation/replay evidence», якого prune-правило вже
     ВИМАГАЄ, але не називає; запуск on-demand у момент prune-рішення,
     НЕ в тірах;
   - `core-code-guidelines.md` §Tests (або language-review-sources
     cross-cutting): property-based (fast-check) як опційна лінза
     незалежного оракула для parser/serializer/round-trip/money-шляхів —
     лінза, не гейт, без мандата залежності.

**Acceptance:** dependabot-шаблон існує І доставляється сідером (e2e
зелений); ADOPTION має обидва мандати + таблицю доставки; AGENTS.md-pointer
у ядрі та шаблоні; три промоушени переміщені Pending → Promoted з розлитим
у гайди текстом.

## Свідомо відхилено (щоб не перелітигувати)

| Кандидат | Чому ні |
|---|---|
| SaaS-рев'юери (CodeRabbit, Greptile, Bugbot, Copilot review, Sonar*, Codacy, Qlty) | Імовірнісні hosted-гейти; порушують no-egress; слот зайнятий Codex Gates + deep-review. Self-hosted Qodo/PR-Agent — максимум опційна згадка в ADOPTION. |
| Biome замість ESLint | Втрачаємо hand-tuned typed+plugin стек (вкл. suppression-guard, який Biome v2 не відтворює) заради швидкості, якої не бракує. |
| Semgrep / ast-grep зараз | Дублюють ESLint+CodeQL+security-guide для нашого стека; нема конкретного правила, якого ESLint не виразить (YAGNI). |
| TruffleHog | gitleaks fail-closed уже закриває edge; AGPL + outbound-виклики. |
| SLSA / SBOM / Sigstore | SHA-pin сабмодуля + checksum-verified gitleaks уже дають цілісність; церемонія без загрози. |
| Socket.dev у core | Hosted/мережевий — проти offline-постури; лише опційна згадка для консюмерів. |
| Registry-евристики в check-new-deps (вік, downloads, edit-distance) | Мережа ламає offline-постуру тірів; паркуються до першого реального прориву фантома (тоді — окремий `audit`-tier report-only чек). |
| Mutation testing у тірах | Лишається ПАРКОВАНИМ за тригером 4.4; N4.4 лише називає інструмент. |
| Окремий AGENTS.md-КОНТЕНТ | Два джерела правди не заводимо; pointer/symlink — так (N4.3), повноцінний паралельний док — ні. |
| GitClear-метрики churn/maintainability | YAGNI; якщо колись — `git log --numstat` у наявний `quality-report.mjs`, не SaaS. |
| promptfoo / DeepEval | Нема LLM-фічі, чий вихід треба скорити; калібрувальний loop — уже eval-гарнес на гейтах. |
| АІ-генератори тестів (Qodo Cover, Diffblue, Keploy) | dev-standards гейтить тести, не генерує; генерація — робота агента консюмера. |
| «Суворіші гейти для АІ-коду» (Sonar AI Assurance routing) | Детекція «АІ-авторства» ненадійна; ми вже гейтимо ВЕСЬ код однаково суворо. |

## Порядок і залежності

Блок 0 (S) → N4 (S, незалежна) і N1 (M, незалежна) → N2 (= Фаза 3
роадмапу, M) → N3 (= Фази 4.1/4.2; 4.1 після git_staged-філесета й
бюджетів з N2; 4.2 після coverage-provider з N2). Кожна фаза — свій
low-level план + Gate P перед диспатчем; Gate C після коду.
