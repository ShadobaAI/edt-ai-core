# Requirements workflow

Общий контракт для design, change и change-focused review. Основной подбор
выполняется средствами v8std по коду/контексту. Bundled `policy/registry.json`
задаёт baseline, а не закрытый перечень применимых норм. Используй MCP `policy`,
а не ручную копию его таблицы. Он не читает файлы и не выполняет изменения.
Текущий [контракт policy 2.1](../../../policy/README.md) отделяет оценки агента,
покрытие реестра и проверку согласованности ledger от доказанного соответствия.

## Режим и предмет проверки

Сначала выбери режим по поручению, затем применимые фазы. Запрос ревью или запуска
теста сам по себе не разрешает исправления.

| Режим | Предмет оценки | `phase` |
| --- | --- | --- |
| Design | Конкретное предлагаемое решение и известный контекст | `proposal` |
| Create/change | Переход baseline → предложение до записи; baseline → фактический результат после неё | `proposal`, затем `result` |
| Review | Точная проверяемая ревизия и её изменение относительно базы | `result` |
| Run/report-only | Фактический запуск/отчёт без authoring | Нормативный authoring workflow не требуется |

Baseline — исходное состояние, полученное через назначенные authorities.
Proposal — проектируемое состояние с конкретными изменениями, а не утверждение
о выполненной записи. Его можно подготовить в памяти из разрешённых baseline
facts; создавать временный объект в EDT ради detection не нужно. Result —
подтверждённое состояние после операции или точная ревизия при ревью.
В `sourceRef` различай baseline, proposal и result и связывай их с target,
ревизией/hash и разрешённым контекстом. Несуществующий target при create не
отменяет проверку проектируемого объекта и его владельца.

Detection описывает механизмы **оцениваемой операции и затронутого контекста**.
До записи учти добавляемые и удаляемые механизмы по baseline и proposal; после
записи — по тому же baseline и actual result. Например, планируемый первый запрос
уже требует `query_text: present` в proposal assessment. `metadata_delete`,
`metadata_rename` и `changed_signature` остаются фактами перехода и после записи:
отсутствие удалённого объекта не делает операцию удаления отсутствующей.
Не включай механизмы постороннего кода только из-за нахождения в том же модуле.

## Подбор, detection и selection

1. Установи artifact (`bsl`, `query`, `metadata`), operation (`design`, `create`,
   `change`, `review`), target и owning scope. Получи минимальное разрешённое
   baseline/result evidence из назначенного EDT/code-index/BSL LS, включая
   существенный enclosing context. При review источник обязан соответствовать
   проверяемой ревизии; текущая модель или индекс другой ревизии её не заменяют.
   Proposal evidence включает конкретное предложение и проверенные baseline
   facts. Не читай защищённые исходники через generic filesystem.
2. Выполни [подбор через v8std](discovery.md) по
   затронутым методам/запросам; по контексту — для design,
   metadata и условий вне snippet. Раскрой полезные diagnostic → standard связи,
   оцени кандидатов по точному тексту и сохрани причины исключений/неопределённость.
   Отдельно подбери применимые corporate-правила и framework patterns в их
   collections, если подбор по коду не покрывает их типы. Выбор corpora и
   границы Gherkin workflow описаны в discovery контракте.
   Применимые нормы за пределами baseline передаются в `additionalRequirements`.
   Подбор не заменяет source assessment и не является списком нарушений.
3. Вызови `policy.detect_1c_mechanisms` с `sourceRef`, assessments и
   `format: compact`. Все critical mechanisms берутся из живой schema инструмента.
   Для каждой оценки нужны `status: present|absent|unknown` и непустое evidence.
   Policy не принимает `sourceText` и не классифицирует исходник самостоятельно.
   Комментарий, строка или имя метода не доказывают семантику механизма.
   `present` и `absent` требуют содержательной оценки артефакта/перехода;
   непроверенное остаётся `unknown`.
4. Передай полный ответ `compact-v1` в `policy.select_1c_requirements` как
   `detection`, вместе с target, artifact, operation и union явных/классифицированных
   mechanisms и `additionalRequirements`: массив `{selector, strength, basis}`
   из применимых результатов v8std. Не обрезай coverage. Unknown, противоречия
   и неполные оценки
   блокируют selection. Для metadata учитывай права, события записи/удаления,
   миграцию, rename/delete и другие реально затронутые механизмы, а не только текст.
5. Сохрани весь selection: registry schema/version, kind, target, artifact, operation,
   effective mechanisms, `mandatory`, `recommended`, `digest`, `matchedRows`,
   source reference и `additionalRequirements`. Для baseline strength берётся
   из registry; для additions обосновывается текстом и связывается с digest.
   Если один selector выбран несколькими правилами, читай и проверяй его один раз;
   mandatory имеет приоритет над recommended. Target — стабильная идентичность
   owning scope с проектом/компонентом; ревизия оцениваемой фазы задаётся `sourceRef`.
   Обработка результата запроса не означает наличие текста запроса в этом scope.
   Другой target или переход design → create/change/review требует собственного
   selection, даже при тех же нормах. Достаточный текст норм переиспользуется.

При `status: unavailable, reason: registry_coverage_missing` нет selection или
digest для compliance. Не передавай такой ответ в `validate_compliance`, не
создавай искусственный digest и не считай отсутствие покрытия освобождением от
норм. `uncoveredMechanisms` перечисляет механизмы без подходящих строк; общие
baseline rules не скрывают этот пробел. Наличие строк не доказывает полноту
реестра относительно корпуса. Недоступный policy, неизвестная применимость или
missing registry coverage блокируют зависимую запись/заключение о соответствии.
Additions расширяют выбранные нормы, но не устраняют пробел mappings для
заявленного registry mechanism. Допустим bounded поиск
недостающего требования через v8std и частичный read-only отчёт о подтверждённых
фактах, но это не успешное прохождение обязательного workflow.

## Точный текст и proposal

6. Получи каждый ещё не прочитанный точный ID/heading через v8std. Для
   selector `document-id#heading` загрузи именно этот раздел; для общего ID —
   достаточный полный текст. Специальную pattern/API card выбирай только по
   поддержке соответствующей коллекции в живом контракте. Достаточный текст
   из уже полученного context-ответа не перечитывай. Проверь
   `found=true`, соответствие selector и отсутствие truncation; дочитай необходимые
   условия и исключения. Неполное или конфликтующее обязательное evidence блокирует
   зависимую проверку. Registry metadata не заменяет нормативный текст.
7. Сопоставь предложение, enclosing structure и caller impact с полученными
   требованиями. До записи вызови `policy.validate_compliance` с явным
   `phase: proposal`, сохранённым `selection`, полным `ledger` и `current`.
   `current` означает актуальную оценку **этой фазы**: для proposal это
   baseline → предлагаемое состояние, для result — baseline → actual result.
   Передай `current.target`, `artifact`, `operation`, `sourceRef`, `mechanisms`
   и для oneC полный `detection` с тем же `sourceRef`, а также текущие
   `additionalRequirements` (включая basis). Target/artifact/operation
   обязаны совпадать с selection. Detection исходника
   до планируемых изменений не подставляется вместо proposal detection.
   Противоречие planned mechanism с baseline `absent` разрешай оценкой proposal,
   а не удалением нового механизма из selection. Существенная правка предложения
   требует обновления assessments и при изменении применимости — selection и
   proposal ledger до writer.

Каждая строка ledger относится к одному выбранному selector и содержит только:
`selector` (точный нормативный selector, не ID строки registry), `selection_digest`
(selection `digest`), `target`, `source_ref`, `status`, `evidence` и, при отклонении,
`reason`. `target` совпадает с selection/current, `source_ref` — с текущим
`current.sourceRef`. Текстовые поля непустые. Статусы строк: `passed`, `failed`,
`unverified`; только recommended допускает также `deviated` с содержательным reason.
`compliant`, `satisfied`, непроверенное `passed`, дубли, лишние поля и пропущенные
требования недопустимы.
Evidence связывает конкретное условие нормы с проверенным target, а не просто
повторяет ID документа. `failed` и `unverified` возвращают структурированный
`status: blocked` с `unresolved`, а не ошибку MCP. Ошибка MCP означает некорректный
или несогласованный запрос. Зависимая запись/полное заключение о соответствии
при `blocked` недопустимы; read-only отчёт о нарушениях и пропусках допустим.
При mandatory `passed` и recommended `passed`/обоснованном `deviated` возвращается
`ledger_valid`: это согласованный реестр оценок, а не доказательство истинности
evidence или разрешение записи.
Не отправляй выдуманный `passed`, чтобы получить такой ответ.

## Result и актуальность

8. После изменения оцени фактический результат и enclosing invariants. Для M/H
   повтори detection на актуальном evidence. L может переиспользовать оценки
   только после проверки, что реальные механизмы и контекст остались прежними;
   references и ledger всегда обновляются на фактический snapshot результата.
   Новый/удалённый механизм, artifact/operation, registry version, corpus revision,
   релевантное исключение или противоречие требуют явного пересмотра применимости.
   При отличии кода/контекста от проверенного proposal обнови v8std-подбор по
   discovery контракту. Изменение additions также требует selection заново.
   При смене selection сохрани причину и получи только новые/инвалидированные нормы.
9. Проверь result по сохранённому полному тексту и отправь новый ledger с
   `phase: result` и фактическим `current`. При новой ревизии обнови `source_ref`
   и содержательное evidence каждой строки; старый ledger отклоняется. Применимость
   с теми же target/механизмами можно переиспользовать. Proposal не заменяет result.
   Если после записи обнаружено новое обязательное условие, не объявляй завершение:
   проверь его и, при необходимости, проведи корректирующее изменение через новый
   proposal и guarded EDT workflow.

Не повторяй успешные эквивалентные selection/retrieval/compliance в одной фазе
без инвалидирования evidence. Разные фазы всегда имеют отдельную проверку.
EDT diagnostics, query validation и поведенческие тесты остаются самостоятельными
gates; L/M/H не снижает нормативную силу требований.

Read-only design проверяет предложенное решение без mutation/launch; review
проверяет зафиксированную ревизию с `operation: review`, `phase: result`.
У review нет proposal, у design нет выполненного result. Недоступный runtime
не блокирует доступные статические выводы и не становится пройденной проверкой.
При частичной проверке явно перечисли непроверенные требования и не выдавай
отчёт за полное заключение о соответствии.

## YaXUnit

Для authoring/design/review/debug/migrate дополнительно используй
`policy.select_yaxunit_requirements` с target, операцией, union фактических test
mechanisms и дополнительными применимыми patterns из v8std-подбора.
Mechanism names берутся из schema, а не из pattern IDs. Получи точные patterns
через v8std и примени тот же ledger/phase контракт. Для изменения BSL нужны и
общие oneC требования, и test patterns; это разные selections, а не дублирующий
поиск. Run/report-only не требует authoring patterns и не разрешает изменение
теста. Selector для `run/report` возвращает `not_applicable` с причиной
`authoring_not_requested`, без digest; его нельзя передавать в compliance.
Это не оценка результата запуска. Полный YaXUnit authoring/runtime workflow остаётся в $yaxunit-tests.
Для общего oneC selection используй поддержанную операцию: `design`, `create`,
`change` или `review`. Диагностика без исправления — `review`; исправление теста
при debug/migrate — `change`. Фазы выбирай по таблице выше, а не по имени навыка.

`validate_compliance` проверяет согласованность заявленного ledger, digest,
текущей применимости и coverage. Он не читает v8std или source и не доказывает
истинность предоставленных оценок. Фактическую проверку текста и кода выполняет
агент; ссылки на evidence и границы этой проверки должны сохраняться в результате.
