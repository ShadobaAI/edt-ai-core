# Контракт policy 2.1

Policy — локальный read-only проверяющий модуль. Он нормализует оценки механизмов,
выбирает baseline из встроенного реестра, объединяет его с дополнительными нормами
из v8std и проверяет согласованность ledger. Основной подбор по коду/контексту
выполняется через [v8std discovery](../skills/1c-standards/references/discovery.md),
исходники и нормативные тексты оценивает агент по разрешённым источникам.
Policy не читает проектные файлы, не вызывает EDT/v8std и не разрешает запись.
Общий рабочий процесс описан в
[requirements](../skills/1c-standards/references/requirements.md).

## Факты и применимость

Для обычной задачи доступны дополнительные session-инструменты:
`assess_1c_requirements` объединяет detection и selection, возвращая полный
selection и ссылки `selectionRef`/`detectionRef`. `validate_compliance_ref`
принимает эти ссылки, явный current/phase и компактные строки
`[selector,status,evidence,reason?]`. Backend восстанавливает полный запрос и
выполняет тот же `validateCompliance`; проверка sourceRef, target, mechanisms,
покрытия, фаз и mandatory не ослабляется. Ссылки действуют только в создавшей их
MCP-сессии, не являются разрешениями и могут истечь после 64 сохранённых записей.
При смене sourceRef нужен новый detection; новое evidence и отдельный result
ledger обязательны. Исходные инструменты полного протокола сохраняются.

`detect_1c_mechanisms` сохраняет название ради стабильного маршрута навыков,
но фактически проверяет и нормализует assessments вызывающего агента.
`sourceText` исключён из API: регулярные выражения не устанавливают тип receiver,
область переменной, экспортный контракт или смысл строки с `SELECT`.
Предоставляй `present|absent|unknown` и evidence из назначенного EDT/index/analyzer.
Неуказанная оценка остаётся `unknown`; policy не превращает её в факт.
Непустое evidence является утверждением вызывающего, а не проверкой его истинности.

Assessment относится к конкретной фазе и операции с затронутым контекстом.
Для изменения учитываются baseline и оцениваемое состояние; механизм удаления
не исчезает из result assessment после успешного удаления объекта.
Design оценивает конкретное предложение, review — зафиксированную ревизию.

У неоднозначных механизмов следующий смысл:

| Механизм | Что требуется установить |
| --- | --- |
| `query_text` | Текст запроса затронут в оцениваемом scope/переходе; имя метода или получение готового результата этого не доказывают. |
| `query_result_processing` | Обрабатывается именно результат запроса; тип/контракт получателя подтверждён разрешёнными фактами. |
| `module_variable` | Переменная принадлежит модулю; локальный `Перем` внутри метода недостаточен. |
| `export_contract` | Затронут экспортный интерфейс, а не литерал/комментарий со словом «Экспорт». |
| `changed_signature` | Сигнатура меняется в переходе baseline → proposal/result. |
| `metadata_rename`, `metadata_delete` | Изменяется идентичность или удаляется объект метаданных, а не только его упоминание. |
| `transactional_test` | Тест использует транзакционный режим; наличие persistent data устанавливается отдельно. |
| `nontrivial_predicate` | Затронут нетривиальный test predicate; database assertion не следует из этого автоматически. |

Selector объединяет явные, классифицированные и подтверждённые detection-механизмы.
Вычисляемые связи ограничены отношениями понятий: например,
`changed_signature → method_contract`, `persistent_data → test_data`.
Они не выводят отсутствующие факты об исходнике. Query mechanisms сами по себе
не добавляют `query_text`; обработчик готового результата может не содержать его.
Полная проверка critical assessments обязательна для oneC selection; неизвестный
critical факт или противоречие блокирует его. Для YaXUnit используется собственный
словарь механизмов; oneC detection в этот selector не передаётся.

## Покрытие реестра

`registry.json` хранит применимость и точные selectors, без нормативного текста.
У правила `any` задаёт условие выбора. `covers` только отмечает механизм,
покрытый безусловным для заданных artifact/operation правилом; это не условие
совпадения. Например, authoring baseline покрывает `test_behavior` при design/create.
Одновременные `any` и `covers` запрещены, чтобы эти роли не смешивались.

Каждый effective mechanism должен иметь покрытие среди реально выбранных строк.
Общие baseline rows не скрывают механизм без подходящего правила. Отсутствие
строк или такое неполное покрытие возвращает `unavailable` с
`reason: registry_coverage_missing` и `uncoveredMechanisms`, без digest.
Это проверка покрытия **заявленных механизмов встроенным реестром**; она не
доказывает полноту перечня механизмов, корпуса или таблицы нормативных связей.

Для YaXUnit `run/report` возвращается `not_applicable` с причиной
`authoring_not_requested`. Это не selection и не доказательство успешного теста.
Authoring mechanisms, включая неизвестные, не создают authoring gate в этих режимах.
Названия переданных механизмов всё равно проверяются по словарю.

## Нормы за пределами baseline

В оба `select_*_requirements` можно передать `additionalRequirements`:

```json
[{"selector":"std740","strength":"mandatory","basis":"Точный источник/редакция, условие нормы и применимость к target"}]
```

Это не сырые search hits: агент предварительно читает точный нормативный текст
и устанавливает применимость/силу требования. Допускаются exact std,
corporate work, YaXUnit и Vanessa pattern selectors, в том числе с heading. Diagnostic ID,
score и confidence не заменяют нормативный selector или basis. Реестр не обязан
знать отдельный ID: например, найденный v8std std740 включается без новой строки
registry. Additions не устраняют `registry_coverage_missing` для уже заявленного
механизма, не превращают неизвестный assessment в факт и не понижают baseline.

Additions сортируются по selector; дубли в самом массиве отклоняются. Если selector
совпадает с baseline, ledger содержит одну строку, mandatory имеет приоритет.
Набор additions вместе с strength/basis связан с digest и сохранён в selection.
В `validate_compliance.current` передай актуальный массив; его удаление/изменение
требует selection заново. Все добавленные нормы проверяются тем же ledger и
возвращают `blocked` при `failed/unverified`. Для YaXUnit `run/report` непустые
additions отклоняются: это не authoring selection.

Пустой/отсутствующий массив не меняет selections/digests протокола 2.0. Policy
не вызывает v8std, не удостоверяет basis и не обнаруживает пропущенные кандидаты
самостоятельно. Учёт найденных/отклонённых/неразрешённых кандидатов ведётся в
workflow; добавление этого API не создаёт технического перехвата EDT writer.
Vanessa additions применимы в существующем oneC/YaXUnit target, когда этого
требует его контекст. Отдельный Gherkin selector в policy не реализован;
нормативная проверка feature сохраняется в отчёте Vanessa workflow.

## Привязка ledger и результаты

Selection относится к одному `target`: стабильному scope с проектом/компонентом.
Он включён в digest вместе с kind, artifact, operation, mechanisms, выбранными
нормами и непустыми additionalRequirements. `current.target/artifact/operation`
должны совпадать с selection.
Для проверки нескольких независимых scopes используй отдельные selections;
enclosing context конкретного scope можно ссылать в evidence.

`current.sourceRef` обозначает конкретное состояние оцениваемой фазы.
Для oneC он совпадает с `current.detection.sourceRef`. Каждая строка ledger
содержит `selector`, `selection_digest`, `target`, `source_ref`, `status`, `evidence`
и при deviation — `reason`. `target` и `source_ref` должны совпадать с current.
`selector` — нормативная ссылка, а `matchedRows` содержит внутренние ID registry.

При изменении source revision можно переиспользовать selection, если scope и
применимость прежние. Ledger для нового состояния проверяется заново и получает
актуальный `source_ref` и содержательное evidence. Простая замена ссылки без
проверки не делает старую оценку истинной. Policy проверяет согласованность этих
утверждений, а не их происхождение, подлинность или свежесть в EDT.

| Результат | Значение |
| --- | --- |
| `ledger_valid` | Ledger содержит все selectors данного selection и согласован с current; mandatory строки имеют `passed`, recommended — `passed` или обоснованное `deviated`. Полнота подбора норм, истинность evidence и разрешение writer из этого не следуют. |
| `blocked` | В структурно корректном ledger есть `failed` или `unverified`; `unresolved` перечисляет selectors, strength и статусы. Workflow допускает read-only отчёт и запрещает зависимую запись/полное заключение о соответствии. MCP сам не перехватывает writer. |
| MCP `isError` | Некорректный запрос, устаревший/изменённый selection, несовпадение контекста, неполный ledger или недопустимый mandatory deviation. |

`counts` считает строки ledger и отклонения; это не число независимо проверенных
норм. Design допускает только `phase: proposal`, review — только `phase: result`.
Create/change использует обе фазы; сервер не хранит историю их выполнения.
Точность нормативного текста, его полнота/редакция, проектные исключения,
EDT diagnostics и поведенческие результаты проверяются отдельно по workflow.
EDT primary validation и BSL LS не являются безусловным доказательством ошибки:
применяй общий [контракт диагностики](../skills/1c-routing/references/diagnostics.md),
учитывая правило, настройки, ревизию и полноту контекста.

Общие action tools проверяют только объявленные effects/scope и caller evidence
реального пользовательского поручения. Они не аутентифицируют человека, не
вычисляют эффекты произвольного инструмента и не заменяют host approvals.

## Переход с 1.1

Версия исходного пакета — `0.2.1`, протокола — `2.1.0`, registry schema — `2`,
registry — `2026-10-20.1`.
Переход с 1.1 несовместим: selections и ledgers нужно пересоздать. Дополнение
2.1 сохраняет формат и digest 2.0 при отсутствии additions.

- Вместо `sourceText` передавай явные assessments из разрешённых фактов.
- В оба selector добавлен обязательный `target`.
- В current обязательны `target`, `artifact`, `operation`, `sourceRef`, `mechanisms`.
- В ledger `rule_id` заменён на `selector`, добавлен `source_ref`.
- `status: passed` ответа validator заменён на `ledger_valid|blocked`; счётчики
  передаются как `counts`. Статус `passed` отдельной строки ledger сохранён.
- `run/report` больше не создают пустой selection с passing digest.

## Рекомендации по дальнейшему развитию

1. Поддерживать сверку selectors и exact headings с corpus revision. Офлайн-сверка
   исходников v8std от 20 октября 2026 подтвердила все 73 уникальных selectors;
   см. [границы и evidence](../docs/VERIFICATION.md). Она не проверяет опубликованный
   MCP, полноту всех нормативных связей или состояние полного runtime package.
   Структурные тесты registry не заменяют такую приёмку.
2. При усилении evidence получать receipts от source/normative authorities:
   идентичность артефакта, ревизию/hash, точный selector, полноту и редакцию текста.
   Проверять их доверенной стороной; добавление ещё одного self-reported поля
   само по себе не создаёт доказательства.
3. Использовать существующий v8std code/context retrieval для кандидатов и
   EDT/analyzer для проверяемых source facts. Не поддерживать второй частичный
   BSL parser или дубликат поискового индекса внутри policy. Heuristic confidence
   v8std не превращать в подтверждение ошибки или полноты подбора.
4. Машинное применение project exceptions вводить вместе с проверяемыми scope,
   источником, условием и ревизией исключения. До этого profile exceptions и
   противоречия явно разбирает агент; checker не интерпретирует их автоматически.
