---
name: 1c-routing
description: Use when choosing a 1C authority or skill route from the active project profile.
---

# Profile-driven routing

Маршрутизация берётся из effective profile и plugin MCP settings:
профиль выбирается по текущему каталогу репозитория, URL — с учётом текущего
`EDT_AI_INSTANCE` и overrides. Два экземпляра одного каталога могут иметь разные
URL; adapter/unit/conversion Kafka выбираются собственными repo-local profiles.
Прочитай общую [action policy](references/action-policy.md) перед проектными
операциями; переиспользуй её и разрешения до изменения scope/условий.

Сначала установи порученный режим: discovery/design/review, implementation или
runtime execution. Проверка/finding сама по себе не переводит задачу в запись,
а authoring не разрешает запуск ИБ. Проверяй готовность только authorities,
нужных зависимому действию: полная readiness среды не является условием любого
чтения. Исторический diff требует evidence той же ревизии, live mutation —
готовой модели и актуальных guards; одно не подменяет другое.

| Задача | Обязательная authority |
| --- | --- |
| Live metadata, EDT change, primary diagnostics | `edt` |
| Platform API reference, execution context, compatibility | `edt` / $1c-platform-docs |
| Installed BSP definitions and API usage | `code-index`; `edt` for live facts / $1c-platform-docs |
| Read-only structure, references, impact | `code-index` |
| Focused BSL diagnostics/navigation | `bsl-ls` |
| Standards and normative corpus | `v8std` |
| Deterministic applicability and proposal/result ledger | bundled read-only `policy` / $1c-standards |
| Runtime launch/debug state | `edt` / [runtime contract](references/runtime.md) |
| Performance measurement | `edt` / [profiling workflow](references/runtime.md#замер-производительности) |
| External processors/reports, localization, specialized artifacts | `edt` / [artifact workflows](references/edt-artifacts.md) |
| Configuration comparison / decision files | `edt` / [comparison contract](references/comparison.md) |

`edt` и `v8std` запускаются пользователем и подключаются по URL из настроек
плагина. `code-index` и `bsl-ls` устанавливаются и запускаются ядром. Не
подменяй missing authority соседним MCP и не выводи alias из близости каталогов.
Проектный профиль определяет конкретные roots, aliases и ownership.
Для индексного discovery и анализа применяй $1c-code-index: выбирай по вопросу
специализированный компактный ответ и учитывай полноту, слои готовности и отсев
повторной выдачи. Не заменяй структурированный анализ серией общих grep/SQL.
Диагностические findings оценивай по [общему контракту](references/diagnostics.md):
назначение primary authority не гарантирует истинность замечания. Для BSL LS
учитывай настройки и покрытие; абсолютные проценты достоверности не назначай.
Для нового EDT binding, неизвестной поверхности или проверки обновления прочитай
[подключения, бюджет и toolsets](references/toolsets.md). Каждой независимо
выбранной конфигурации/каталогу нужен свой запущенный EDT-MCP с назначенным URL;
сессия MCP не изолирует общее состояние EDT. Проверяй точное соответствие проекта.
Выбирай минимальный достаточный ответ с серверными фильтрами; не дублируй
индексный discovery через EDT без недостающего live-факта. Раскрывай только нужные
группы; specialized references читай только для выбранного сценария.
`policy` поставляется внутри плагина, запускается через Node и не требует URL
или отдельной установки. Он выбирает точные требования; нормативный текст
получай только из `v8std`. Missing policy не разрешает упрощать compliance.
Общий read-only v8std допустим для параллельных проектов; отдельный сервер на
каталог не нужен. Его живой контракт, экономия выдачи и границы reuse описаны в
[v8std MCP](../1c-standards/references/mcp.md). Подбор по коду/контексту и ledger
не переносятся между проектами даже при совпадающих alias и ID норм.
Платформенная справка использует EDT; дополнительный documentation MCP в ядро
не входит. Подробный маршрут и обработка пробелов принадлежат $1c-platform-docs.
