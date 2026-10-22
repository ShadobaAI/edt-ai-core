# Источники и происхождение

## Репозитории проекта

| Назначение | Источник |
| --- | --- |
| Исходники 1C AI Core | [ShadobaAI/edt-ai-core](https://github.com/ShadobaAI/edt-ai-core) |
| Установочный Git-магазин | [ShadobaAI/codex-plugins](https://github.com/ShadobaAI/codex-plugins) |
| Регистрация и устройство магазинов Codex | [Официальная документация OpenAI](https://developers.openai.com/plugins/build/plugins) |

## Внешние компоненты

Registry компонентов задан в [components.mjs](../scripts/components.mjs),
release/runtime contract — в [runtime-manifest.yaml](../runtime/runtime-manifest.yaml).

| Компонент | Источник/назначение |
| --- | --- |
| Code-index | [Regsorm/code-index-mcp](https://github.com/Regsorm/code-index-mcp), managed release binary |
| BSL Language Server | [1c-syntax/bsl-language-server](https://github.com/1c-syntax/bsl-language-server), внешний JAR |
| Koffi | [Koromix/koffi](https://github.com/Koromix/koffi), bundled Windows API bridge |
| Unicode case folding | [Unicode](https://www.unicode.org/), данные и отдельная лицензия в пакете |
| EDT-MCP | Сервер пользователя; проверяется по живому MCP-контракту |
| v8std: исходный проект | [zeegin/v8std](https://github.com/zeegin/v8std), основа |
| v8std: рекомендуемый форк | [ShadobaAI/v8std](https://github.com/ShadobaAI/v8std), форк автора 1C AI Core с базой знаний по Vanessa и YaXUnit |
| v8std: готовый Docker-образ | [aleksp99/v8std-mcp](https://hub.docker.com/r/aleksp99/v8std-mcp), образ автора 1C AI Core из ShadobaAI/v8std с базой знаний по Vanessa и YaXUnit |

v8std запускается пользователем отдельно и проверяется по живому MCP-контракту.

Версии Node-библиотек закреплены в `package-lock.json`. Авторство и лицензии
перечислены в [NOTICE.md](../NOTICE.md), [UNICODE-LICENSE.txt](../UNICODE-LICENSE.txt)
и генерируемом `vendor/NOTICE.txt`. Детали происхождения policy —
в [mcp/PROVENANCE.md](../mcp/PROVENANCE.md).

## Источники универсальных навыков

| Окружение | Репозиторий | Навыки |
| --- | --- | --- |
| CRM | [crm-ai-dev](https://git.fsk.ru/ShadobaAI/crm-ai-dev.git), требуется доступ к корпоративному Git | `skills/` |
| Kafka | [kafka-tools](https://github.com/ShadobaAI/kafka-tools.git) | `ai/.codex/skills/` |

Наблюдаемые ревизии и принятые решения находятся в
[skills/catalog.yaml](../skills/catalog.yaml). Текущая полнота миграции
не следует из одного наличия навыка: нужно сверять поведение с доступным
источником и учитывать `migration_decisions`.

В ядро переносится универсальное поведение. Проектные пути, aliases,
EDT-проекты, профили и exports не поставляются; остаётся только `generic-1c`.
`1c-docs-mcp` (HelpSearchServer) и `1c-ssl-mcp` исключены, включая optional
и fallback варианты. Замещающие маршруты оцениваются отдельно.
Текущий контракт знаний и MCP ИБ описан в [INTEGRATIONS.md](INTEGRATIONS.md),
этапы реализации — в [ROADMAP.md](ROADMAP.md).
