---
name: vanessa-ui-tests
description: Design, review, author, research, record, run or debug Vanessa Gherkin UI scenarios when enabled by the project profile. Choose static or runtime work from the request; not product source changes or unit tests.
---

# Vanessa UI tests

## Binding и знания
Применяй knowledge mode и source roles из $1c-routing; при выборе новых steps/
механизмов и проверке diff — общие контроли reuse/достаточности. Authoring,
review и execution не взаимозаменяемы. Разрешение менять UI-тест не разрешает
менять product source или framework, а failure run не даёт права исправлять их.

Проверь `testing.vanessa` и `testing.vanessa_config`: test `repository_id`,
`features`, `results`, `runtime_profile` и `server_name`. Для runtime-операций
прочитай локальный runtime JSON: он задаёт реальные manager/TestClient bases,
платформу, Vanessa и endpoint; его машинные настройки не являются переносимым
содержимым project profile. Не
выводи base по имени сервера и не используй клиент другого проекта. Product
source меняется через отдельный EDT workflow; UI-тест его не разрешает.

Факты Vanessa, syntax, recipes и version limits получай из `v8std`, не из копий
upstream prompt. Известный ID читай прямо документом/разделом, проверь `found`,
ID и полный body. Для выбранного design/review/authoring используй
подбор по контексту в поддерживаемой коллекции `vanessa` с краткой целью,
структурой сценария и затронутыми механизмами. Применимые corporate-правила
подбирай отдельно в `collections=[corporate]`; общий top-N может скрыть corpus.
Порядок разбора кандидатов, точного текста и исключений задан в
[общем discovery контракте](../1c-standards/references/discovery.md).
Gherkin не передавай в подбор для BSL/SDBL. Специальная карточка другого framework
не заменяет точный документ Vanessa; выбирай по [живому контракту](../1c-standards/references/mcp.md).
Незнакомую тему дополнительно ищи bounded в `collections=[vanessa]`.
`vanessa:patterns:catalog` помогает выбрать лишь нужные recipes:

- setup: `vanessa:patterns:environment-readiness`;
- исследование/запись: `vanessa:patterns:exploration-recording`;
- структура/authoring: `project-layout`, `feature-sections`, `steps-assertions`;
- reuse/data: `subscenarios-and-libraries`, `scenario-outlines`, `test-data-strategies`;
- запуск: `execution-debugging`; отказ: `failure-classification`, `modal-dialogs`.

Короткие имена выше имеют тот же prefix `vanessa:patterns:`. Tool cards
`vanessa:mcp:<tool>` поясняют semantics; актуальный полный `tools/list` определяет
schema. Не угадывай параметры другой версии. Неподтверждённый обязательный
контракт блокирует зависимую операцию. Пример структуры/сброса БД не является
универсальным требованием. Сохраняй достаточные уже полученные факты.
В статическом отчёте связывай применимые нормы с feature/revision/scenario,
условием, силой и результатом проверки (`passed`, `failed`, `unverified`;
обоснованное `deviated` только для рекомендательного условия). Для proposal
и actual result evidence различается; findings/непроверенные условия сохраняются.
У policy нет Gherkin selector: не подменяй feature BSL/YaXUnit артефактом ради
`ledger_valid`. Это учёт нормативной проверки, отдельный от runtime run receipt.

## Режим работы

- **Design/review**: исследуй сценарий и business result, сообщи решение/findings.
  Нет записи feature, подключения к manager, запуска, recording или receipt.
- **Author/change**: измени разрешённые features в UTF-8, сохраняя conventions.
  Переиспользуй стандартные steps, subscenarios и данные. Navigation без проверки
  business result — недостаточный assertion. Для статического authoring локальный
  runtime JSON и запущенная 1С не нужны; непроверенные runtime syntax/run укажи явно.
- **Research/record**: используй живую сессию только для нужного исследования и
  разрешённых UI-effects. Запись наблюдений сама по себе не разрешает менять feature.
- **Run/report-only**: запусти выбранный существующий scenario либо проанализируй
  уже полученный отчёт. Report-only не запускает новый тест. Failure не разрешает
  исправление feature/product.
- **Debug**: сначала классифицируй отказ. Меняй тест только если поручение включает
  исправление; иначе сообщи причину и проверенное evidence.

Читай нужные recipes для выбранного режима. Статическая проверка и выполненный
runtime test имеют отдельные результаты; authoring не обещает runtime pass.

## Цикл при работе с runtime

Эти шаги применяются только к выбранным runtime-операциям, не как обязательный
setup для design/review/offline authoring.

1. Прочитай feature и ожидаемый business result. Проверь actual manager environment,
   точную base TestClient, VanessaExt/VAExtension, версии, idle/execution/recording
   state и владение сессией. Не прерывай чужую работу. Для запуска и воздействия
   на данные примени общую [action policy](../1c-routing/references/action-policy.md).
2. При research/record исследуй нужную UI/fixtures через form analysis и
   internal element names.
   Recording начинай до целевых действий только при установленном ownership;
   сохрани наблюдённые steps/assertions. Не создавай неоговорённые fixtures и не
   изменяй произвольные существующие записи.
3. Перед run открой/загрузи точный файл, выполни `check_syntax`, независимо
   подтверди точные file, scenario и исполняемый текст. Запусти только нужный
   scenario с начала; run-from-step допустим лишь для диагностики.
4. После фактического run прочитай `get_test_results` и свяжи его с тем же
   file/hash/scenario/run. При ошибке изучи actual form и screenshot проверенного
   TestClient window. Если
   PID не установлен, не повторяй discovery бесконечно: используй доступный UI
   инструмент только при независимом подтверждении окна; неоднозначность блокирует
   visual diagnosis. При `paused_modal_dialog` обработай наблюдённый диалог
   только в разрешённом UI/data scope, затем продолжи оставшиеся действия цепочки.
5. В режиме с разрешённым исправлением меняй устаревший тест по evidence;
   не ослабляй ожидание под product defect. Повторяй запуск только обоснованно.
   Один и тот же неизменный сбой не повторяй. Timeout mutation требует проверки
   actual state до новой попытки. Разделяй test/product/data/infrastructure failures.

## Приёмка

Предпочитай configured native MCP. Если он недоступен в чате, bundled CLI и
переход Single/MCP editor описаны в [CLI workflow](references/cli-workflow.md).
Он не требует checkout Kafka или upstream Vanessa, но actual runtime и platform
пользователь предоставляет отдельно. CLI не является разрешением на side effects.

Для фактического запуска сохрани run receipt в `results` по
[receipt contract](references/receipts.md); статический режим его не создаёт.
`completed` control chain не означает `passed` test. Syntax-only, запуск с середины,
skipped/старые/неполные результаты не подтверждают test pass. Отчёт различает
результат выбранного режима, syntax/run outcome и непроверенные части; receipt
указывается только для фактического запуска. Manager/TestClient
оставляй доступными, пока их закрытие не входит в задачу.
