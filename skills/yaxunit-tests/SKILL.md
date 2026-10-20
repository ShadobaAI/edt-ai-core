---
name: yaxunit-tests
description: Design, author, review, run and debug YaXUnit tests, registration, assertions, fixtures and mocks when enabled by the project profile. Not product changes or UI tests.
---

# YaXUnit tests

## Binding и authority

Проверь `testing.yaxunit` и `testing.yaxunit_config`. `repository_id` задаёт
владельца тестового расширения и его `edt_project`; aliases берутся из
`repositories`. `framework_repository_id` — read-only YaXUnit core,
`product_repository_ids` задают доступные для исследования зависимости, а не
разрешение на изменение production. Не выводи
ownership из имени каталога; отсутствие binding блокирует зависимый маршрут.
Не включай возможность и не меняй production/core ради удобства теста.

`code-index` ищет определения и реальные usages; EDT подтверждает live state,
неизвестную установленную сигнатуру, выполняет все записи, primary diagnostics
и `run_yaxunit_tests`. BSL LS нужен только для отдельного focused analyzer-вопроса.
`v8std` даёт известные pattern/API contracts; не дублируй достаточную справку
проверкой каждой сигнатуры в EDT. Противоречие версий сначала разреши.

## Normative и authoring gates

Для design/create/change/review и анализа тестового кода при debug/migrate следуй общему
[requirements workflow](../1c-standards/references/requirements.md#yaxunit):
`select_yaxunit_requirements`, точные полные patterns и ledger применимой фазы:
design — proposal, review — result, изменение — обе.

Подбирай test patterns по контексту в коллекции `yaxunit`, применимые рабочие
правила — отдельно в `corporate`, если они поддержаны назначенным v8std.
BSL snippet дополняет этот маршрут; справочная API card требует чтения контракта
и не становится нормой автоматически. Для известного module/member выбирай
адресную API card по [живому контракту](../1c-standards/references/mcp.md),
переиспользуй полный текст из подбора; неизвестный установленный API проверяй
через index/EDT. Для environment/runner-only
диагностики authoring patterns не нужны. Изменения BSL проходят и общий oneC gate
через $1c-code-change. Повторно
нормы не загружай без изменения применимости. Run/report-only не требует
authoring patterns и не разрешает изменение кода.

До записи установи наблюдаемое поведение, test owner, client/server context,
setup/cleanup, стратегию данных, isolation, assertions и границу mock. Тест
проверяет поведение, не внутреннее устройство реализации. Reuse подходящей
semantic fixture предпочтительнее новой; иначе используй узкий публичный
`ЮТест.Данные()` API. Значения определяй по смыслу полей, форматам, единицам и
связям; подходящий `ЮТПодражатель`/платформенный генератор лучше случайного literal.
Mock изолирует внешнюю границу, а не поведение под проверкой.

Проверь declarative registration, export/context зарегистрированных методов,
placement/naming, deterministic setup и соответствие assertions полному pattern.
Данные не должны зависеть от произвольных существующих записей или портить их.
Сохраняй cleanup/isolation при ошибке теста по применимому контракту.

## Fluent chains

Отступ многострочной цепочки определяется логическим владением по pattern/API,
а не одинаковым типом возвращаемого значения или физическим receiver:

- siblings начинаются в одной колонке;
- child и его настройки на один tab глубже владельца;
- возврат к ancestor/следующему sibling возвращает соответствующий уровень.

Для регистрации: module → set → test → test settings; следующий test — sibling.
Не угадывай иерархию по названию метода; неизвестное владение уточни в pattern.

## Выполнение и приёмка

Прочитай [workflows](references/workflows.md) для текущей операции;
[testability](references/testability.md) — только при конкретном препятствии.
Согласования фактических эффектов следуют общей
[action policy](../1c-routing/references/action-policy.md). Сохраняй уже данное
разрешение для того же тестового окружения; source edit не разрешает запуск ИБ.

Для изменения требуются focused EDT diagnostics, result compliance, authoring
gate; поведенческую проверку выполняй самым узким нужным запуском с разрешёнными
runtime effects. Если runtime недоступен/не разрешён, сообщи отдельно результат
authoring и невыполненную проверку, не объявляя test pass. Неожиданные `0`
найденных/выполненных тестов — сбой, а не pass. Read-only design/review не требует runtime лишь ради
заключения и не разрешает fixes. Отчёт связывает scope, job/run, counts и результаты;
syntax-only, неполный/чужой отчёт или skipped check не выдай за успешный тест.
