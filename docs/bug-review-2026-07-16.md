# Глибоке рев'ю проєкту на наявність багів

- Дата: 2026-07-16
- Перевірений commit: `e173320fcfa9256c04c692cc6024aea8c91876c2`
- Гілка: `main`
- Режим: пошук і підтвердження дефектів без рефакторингу
- Обсяг: `runner/**`, `deep-review/**`, `tools/**`, schema, CLI-контракти та відповідні тести

## Резюме

Підтверджено 12 дефектів: 4 High, 7 Medium і 1 Low. Кожна знахідка нижче має окреме відтворення або детермінований контрприклад. Непідтверджені припущення до звіту не включені.

Найвищий ризик зосереджений у двох місцях:

1. `deep-review` може дозволити handoff, хоча актуальний `HEAD` не пройшов фінальну перевірку.
2. `runner --fix-staged` у двох аварійних/нетипових сценаріях порушує обіцянку локальної та повної rollback-поведінки.

| ID | Пріоритет | Підсистема | Суть |
|---|---|---|---|
| BUG-01 | High | deep-review | Зелений verification stamp можна створити на dirty worktree, але прив'язати до чистого `HEAD` |
| BUG-02 | High | deep-review | Нова червона перевірка не скасовує старий зелений stamp; handoff лишається дозволеним |
| BUG-03 | High | runner | Аварійний formatter лишає дочірні процеси, які змінюють файли після rollback |
| BUG-04 | High | runner | `--fix-staged` форматує hardlink і змінює файл поза репозиторієм |
| BUG-05 | Medium | deep-review | Whole-run budget фактично перезапускається для кожної CLI-команди |
| BUG-06 | Medium | runner | Порожній include-pattern створює false-green blocking check |
| BUG-07 | Medium | runner | Placeholder у `format.argv` може прибрати formatter і зробити staged-файл executable-командою |
| BUG-08 | Medium | runner | Валідні fileset names з крапкою не розгортаються в `{files:...}` |
| BUG-09 | Medium | runner/tools | Три реалізації одного glob-діалекту дають різні результати для валідного manifest |
| BUG-10 | Medium | deep-review | Помилка читання вже переліченого overlay-guide беззвучно прибирає правило з рев'ю |
| BUG-11 | Medium | deep-review | `paths.reports` може перенаправити deep-review report за межі repo root |
| BUG-12 | Low | runner | CLI приймає inherited keys `Object.prototype` як валідний scope |

## Підтверджені дефекти

### BUG-01 — verification stamp створюється на dirty worktree

Пріоритет: **High**

Код: [`deep-review/src/verify.ts:145`](../deep-review/src/verify.ts#L145), [`deep-review/src/verify.ts:159`](../deep-review/src/verify.ts#L159), [`deep-review/src/verify.ts:188`](../deep-review/src/verify.ts#L188), [`deep-review/src/handoff.ts:231`](../deep-review/src/handoff.ts#L231).

`runFinalVerify` фіксує `HEAD` до і після запуску shim, але не перевіряє `git status`. Тому shim може перевірити незакомічені дані, а зелений stamp буде записаний як такий, що підтверджує commit із SHA `HEAD`. Handoff перевіряє лише збіг SHA і чистоту worktree у поточний момент.

Відтворення в ізольованому worktree:

1. `HEAD`-версія `src/app.ts` не проходить verify.
2. У файл без commit додається `PASS_MARKER`; verify стає зеленим.
3. Файл відновлюється через `git restore`, тому worktree знову чистий.
4. Handoff повертає успіх, хоча саме відновлений `HEAD` не проходить verify.

Спостереження:

```text
greenOnDirtyTree: 0
cleanStatusAfterRestore: ""
handoffAfterDiscard: 0
verifyOnActualHead: 13
```

Вплив: handoff може засвідчити неперевірений стан гілки.

Рекомендація: перед і після shim перевіряти non-tooling dirt за тим самим принципом, що й `self-review`; зелений stamp дозволяти лише для чистого дерева, незмінного `HEAD` і незмінного статусу. Додати E2E `dirty green -> restore -> handoff must fail`.

### BUG-02 — червона перевірка не скасовує старий зелений stamp

Пріоритет: **High**

Код: [`deep-review/src/verify.ts:165`](../deep-review/src/verify.ts#L165), [`deep-review/src/verify.ts:195`](../deep-review/src/verify.ts#L195), [`deep-review/src/verify.ts:213`](../deep-review/src/verify.ts#L213), [`deep-review/src/handoff.ts:231`](../deep-review/src/handoff.ts#L231).

`verification` оновлюється тільки при exit `0`. Червоний verdict, timeout, signal або інша operational failure повертають код помилки, але попередній зелений запис не видаляється. Handoff не знає, що після зеленого запуску була новіша невдала спроба.

Незалежне від BUG-01 відтворення на тому самому чистому `HEAD`:

```text
firstVerifyGreen: 0
secondVerifyRed: 13
verificationStillPresentAfterRed: true
handoffAfterLatestRed: 0
```

Вплив: останній фактичний verdict може бути red, але система все одно дозволяє handoff за застарілим green.

Рекомендація: інвалідувати stamp до початку кожної нової verify-спроби або зберігати останню спробу та дозволяти handoff лише для її зеленого результату. Покрити окремими тестами `green -> red`, `green -> signal/timeout` і `green -> post-verify HEAD read failure`.

### BUG-03 — дочірні процеси formatter-а переживають аварію та rollback

Пріоритет: **High**

Код: [`runner/src/exec.ts:41`](../runner/src/exec.ts#L41), [`runner/src/exec.ts:63`](../runner/src/exec.ts#L63), [`runner/src/fix-staged.ts:103`](../runner/src/fix-staged.ts#L103), [`runner/src/git.ts:27`](../runner/src/git.ts#L27).

Process group примусово завершується лише для `ETIMEDOUT`. Якщо безпосередній процес завершується через signal або `spawnSync` повертає іншу operational error, його нащадки лишаються активними. `runFixStaged` уже відновлює snapshot і повертає помилку, але живий worker може змінити файл пізніше.

Відтворення: formatter запускає worker із відкладеним записом і завершує батьківський процес через `SIGKILL`.

```text
runFixStagedExit: 1
fileImmediatelyAfterReturn: "STAGED\n"
fileAfter700ms: "LATE MUTATION\n"
```

Окремий тест із переповненням output buffer (`ENOBUFS`) також підтвердив, що grandchild лишився живим.

Вплив: повідомлення `reverted` не гарантує, що repo справді залишиться відновленим після повернення CLI.

Рекомендація: завершувати й дочекатися process group для всіх abnormal outcomes, а rollback виконувати тільки після cleanup. Аналогічно виправити дубльований шаблон у `runner/src/git.ts`. Додати регресійні тести з worker-marker для timeout, signal та `ENOBUFS`.

### BUG-04 — hardlink дозволяє formatter-у змінювати зовнішній файл

Пріоритет: **High**

Код: [`runner/src/git.ts:82`](../runner/src/git.ts#L82), [`runner/src/fix-staged.ts:89`](../runner/src/fix-staged.ts#L89), [`runner/src/fix-staged.ts:117`](../runner/src/fix-staged.ts#L117).

Захист `--fix-staged` відхиляє symlink та non-regular file, але не перевіряє кількість hardlinks. Regular file у repo може ділити inode з файлом поза repo root, тому форматування за repo-шляхом змінює обидва імена.

Відтворення:

```text
nlinkBefore: 2
runnerExit: 0
runnerMessage: "formatted and re-staged 1 file(s)"
outsideFileAfter: "FORMATTED\n"
```

Вплив: команда, заявлена як операція над staged-файлами репозиторію, без попередження змінює зовнішній файл; успішний шлях не має rollback.

Рекомендація: відхиляти `nlink !== 1` до formatter-а та повторно перевіряти тип/inode/link count після нього. Зафіксувати hardlinks як unsupported input і додати інтеграційний тест поруч із наявними symlink/retype cases.

### BUG-05 — whole-run deadline перезапускається на кожному verb

Пріоритет: **Medium**

Код: [`deep-review/src/deadline.ts:1`](../deep-review/src/deadline.ts#L1), [`deep-review/src/descriptor.ts:23`](../deep-review/src/descriptor.ts#L23), [`deep-review/src/descriptor.ts:33`](../deep-review/src/descriptor.ts#L33), [`deep-review/src/cli.ts:375`](../deep-review/src/cli.ts#L375), [`deep-review/src/cli.ts:473`](../deep-review/src/cli.ts#L473), [`deep-review/src/cli.ts:504`](../deep-review/src/cli.ts#L504), [`deep-review/src/cli.ts:550`](../deep-review/src/cli.ts#L550), [`deep-review/src/cli.ts:603`](../deep-review/src/cli.ts#L603).

Коментарі та конфіг описують один budget для всього run, але кожен CLI verb працює в окремому процесі та викликає `createDeadline(config.budget.seconds)` заново. `created_at` у run descriptor не використовується для обчислення залишку.

Відтворення з `budget.seconds = 1`:

```text
select-worktree: 0
waitedMs: 1250
classifyAfterBudgetExpired: 0
```

Вплив: послідовність із багатьох verbs може працювати необмежено довше за задекларовану стелю; timeout захищає лише окрему команду.

Рекомендація: зафіксувати `budget_seconds`/`expires_at` у descriptor під час створення run; на початку кожного процесу обчислювати залишок і вже його переводити в локальний monotonic deadline. Додати cross-process E2E, який чекає довше budget між двома verbs.

### BUG-06 — порожній include-pattern дає false-green blocking check

Пріоритет: **Medium**

Код: [`schemas/quality.schema.json:72`](../schemas/quality.schema.json#L72), [`runner/src/validate.ts:254`](../runner/src/validate.ts#L254), [`runner/src/validate.ts:404`](../runner/src/validate.ts#L404), [`runner/src/filesets.ts:21`](../runner/src/filesets.ts#L21).

Schema та hand-written validator вимагають непорожній масив `include`, але дозволяють порожній рядок як його елемент. Такий pattern не збігається зі звичайними repo-файлами. Якщо blocking check має `skip_if_empty`, він беззвучно стає `skipped`.

Підтверджений manifest із `include: [""]`:

```text
validatorExit: 0
verifyExit: 0
blockingChildWouldExit: 9
reportedResult: "skipped"
```

Вплив: проста конфігураційна помилка вимикає blocking gate із зеленим загальним exit.

Рекомендація: додати `minLength: 1` для include/exclude items і таку саму semantic check у validator. Додати schema/validator/runtime test для `include: [""]`.

### BUG-07 — placeholder у `format.argv` може замінити formatter staged-файлом

Пріоритет: **Medium**

Код: [`schemas/quality.schema.json:93`](../schemas/quality.schema.json#L93), [`runner/src/validate.ts:294`](../runner/src/validate.ts#L294), [`runner/src/fix-staged.ts:102`](../runner/src/fix-staged.ts#L102), [`runner/src/exec.ts:122`](../runner/src/exec.ts#L122).

Контракт schema каже, що `format.argv` — команда formatter-а, а безпечний список staged-файлів додається runner-ом. Проте validator не забороняє `{files:...}` у `format.argv`, а `fix-staged` пропускає весь масив через загальний `expandArgv`.

Підтверджений випадок:

```text
format.argv before expansion: ["{files:ghost}"]
validation: ok
argv after internal staged-list append/expansion: ["staged.ts"]
```

Невідомий fileset розгортається в нуль аргументів, а внутрішньо доданий staged path стає `argv[0]`, тобто програмою для запуску. Для executable repo-path команда запускає не formatter, а staged-файл.

Вплив: конфігурація, яку validator визнає коректною, змінює executable замість того, щоб лише додати operands.

Рекомендація: повністю заборонити fileset placeholders у `format.argv` та окремо перевірити, що formatter executable існує до внутрішнього append. Додати semantic tests для placeholder у кожній позиції `format.argv`.

### BUG-08 — fileset name і синтаксис token мають несумісні контракти

Пріоритет: **Medium**

Код: [`schemas/quality.schema.json:70`](../schemas/quality.schema.json#L70), [`runner/src/validate.ts:113`](../runner/src/validate.ts#L113), [`runner/src/validate.ts:402`](../runner/src/validate.ts#L402), [`runner/src/exec.ts:106`](../runner/src/exec.ts#L106).

Fileset name обмежений лише `minLength: 1`, тоді як `{files:<name>}` розпізнає тільки `\w` і `-`. Тому ім'я з крапкою валідне у manifest, але не може бути використане через задокументований token.

```text
fileset.name: "src.ts"
manifestValidation: ok
expandArgv(["tool", "{files:src.ts}"]): ["tool", "{files:src.ts}"]
expected operand: "a.ts"
```

Вплив: tool отримує literal placeholder замість списку файлів; залежно від tool це дає false-red або перевіряє не ті дані.

Рекомендація: або обмежити names однаковим regex `^[A-Za-z0-9_-]+$` у schema та validator, або реалізувати однозначний parser для всіх дозволених names. Додати conformance test між validation та runtime expansion.

### BUG-09 — glob semantics розходяться між runner та tools

Пріоритет: **Medium**

Код: [`runner/src/glob.ts:51`](../runner/src/glob.ts#L51), [`runner/src/validate.ts:735`](../runner/src/validate.ts#L735), [`tools/check-companion-tests.mjs:28`](../tools/check-companion-tests.mjs#L28), [`tools/diff-cover.mjs:29`](../tools/diff-cover.mjs#L29).

Validator дозволяє будь-яке розміщення `**`. Runner трактує будь-які дві сусідні зірочки як globstar, що може перетинати `/`. Два tools трактують `**` рекурсивно лише як окремий path segment.

Детерміновані контрприклади:

| Path | Pattern | runner | companion-tests | diff-cover |
|---|---|---:|---:|---:|
| `a/x/b` | `a**b` | true | false | false |
| `src/deep/file.ts` | `src**.ts` | true | false | false |
| `a/x/b/c` | `a**/c` | true | false | false |

Вплив: той самий manifest pattern вибирає різні файли в gate orchestration і в окремих policy tools.

Рекомендація: мати одну спільну реалізацію matcher-а. Найменша сумісна зміна — визнати `**` валідним лише як цілий segment і відхиляти змішані форми у validator; альтернативно всі три matcher-и мають реалізувати однакову ширшу семантику. Додати спільну таблицю conformance cases.

### BUG-10 — read error беззвучно прибирає overlay-guide

Пріоритет: **Medium**

Код: [`deep-review/src/guides.ts:120`](../deep-review/src/guides.ts#L120), [`deep-review/src/guides.ts:139`](../deep-review/src/guides.ts#L139), [`docs/ADR.md:289`](ADR.md#L289).

Enumeration overlay directory fail-closed для помилок, відмінних від `ENOENT`. Але після успішного переліку кожен `readFile` обгорнутий у порожній `catch`, який ігнорує також `EACCES`, `EIO` та інші read failures. Це суперечить ADR-016: listed-but-unreadable overlay повинен fail closed.

Ін'єкційне відтворення: `listMarkdownFiles` повертає `repo-extra.md`, а `readFile` для нього кидає `EACCES`.

```text
loadSucceeded: true
repoExtraLoaded: false
guideCount: 9
```

Вплив: рев'ю продовжується з неповним rulebook, не повідомляючи про втрачений repo-specific guide.

Рекомендація: ігнорувати максимум `ENOENT` як вузьку race-умову; для інших read errors повертати `ok: false` з причиною. Додати unit tests для `EACCES`/`EIO` після успішної enumeration.

### BUG-11 — deep-review report не конфайнить `paths.reports` під repo root

Пріоритет: **Medium**

Код: [`deep-review/src/config.ts:88`](../deep-review/src/config.ts#L88), [`deep-review/src/cli.ts:417`](../deep-review/src/cli.ts#L417), [`deep-review/src/cli.ts:432`](../deep-review/src/cli.ts#L432), [`deep-review/src/report.ts:145`](../deep-review/src/report.ts#L145), [`runner/src/report.ts:18`](../runner/src/report.ts#L18).

Runner передає в `writeConfined` repo root і відносний `paths.reports`, тому `../` та absolute escape відхиляються. Deep-review спочатку робить `resolve(cwd, reportsDir)`, а потім передає отриманий каталог як новий confinement root. Якщо manifest вказує `../outside-reports`, перевірка захищає запис усередині зовнішнього каталогу, але вже не відносно repo.

E2E з реальним CLI та `paths.reports = "../outside-reports"`:

```text
reportExit: 0
stdout: "<sandbox>/outside-reports/deep-review-2026-07-16.md"
outsideDirectoryContents: ["deep-review-2026-07-16.md"]
```

Вплив: спільний manifest path має різну поведінку в runner та deep-review; report може створювати/перезаписувати файл поза заявленим repo root.

Рекомендація: валідовувати `paths.reports` як repo-relative та передавати в atomic writer саме repo root плюс relative target, як це робить runner. Додати E2E для `..`, absolute path і symlinked ancestor.

### BUG-12 — inherited object keys приймаються як scope

Пріоритет: **Low**

Код: [`runner/src/cli.ts:9`](../runner/src/cli.ts#L9), [`runner/src/cli.ts:40`](../runner/src/cli.ts#L40).

`SCOPE_FLAGS` — звичайний object, а lookup не перевіряє own property. Аргументи `toString`, `constructor` тощо успадковуються від `Object.prototype` і проходять як scope.

```text
parseArgs(..., "toString"): ok
scopeType: "function"
fullCliExit: 1
expectedUsageExit: 2
```

Повний CLI також намагався створити report із function string у назві scope замість того, щоб зупинитися на usage validation.

Вплив: невідомий аргумент запускає частину workflow та побічні дії, після чого падає з неочікуваною operational error.

Рекомендація: `Object.hasOwn(SCOPE_FLAGS, arg)`, object із null prototype або `Map`. Додати cases для `toString`, `constructor` і `__proto__`.

## Виконані перевірки

- `rtk npm run verify:full` — green. Етапи повідомили 723 unit/tool tests, 72 ESLint tests і 29 deep-review E2E tests.
- `rtk npm run test:adoption` — 65/65 green.
- Окремий `test:runner` під час паралельної перевірки — 236/236 green.
- Typecheck, build, lint і knip у складі full gate — green.
- ShellCheck не дав нової bug-знахідки: залишилися лише `SC1007` для свідомого `CDPATH= cd` та `SC2015` у тестовій assertion-конструкції.
- Для runtime-кандидатів використовувалися ізольовані тимчасові git-репозиторії; робочий executable surface проєкту не змінювався.

Зелений baseline не спростовує findings: усі 12 випадків лежать у непокритих переходах стану, конфігураційних межах або abnormal process outcomes.

## Рекомендований порядок виправлення

1. BUG-01 і BUG-02 одним verification-state batch із двома незалежними regression tests.
2. BUG-03 і BUG-04 як integrity batch для `--fix-staged`, включно з process-group cleanup.
3. BUG-05, щоб відновити реальну whole-run budget ceiling.
4. BUG-06—BUG-09 як manifest/runner conformance batch із єдиною таблицею schema-validator-runtime cases.
5. BUG-10 і BUG-11 як fail-closed/confinement batch для deep-review I/O.
6. BUG-12 як малий CLI hardening fix.

Цей документ є єдиною зміною, зробленою в репозиторії під час рев'ю; виправлення коду навмисно не виконувалися.
