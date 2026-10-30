# Разработка и сборка

Корень репозитория — исходники одного плагина `1c-ai-core`.
Техническое устройство описано в [ARCHITECTURE.md](ARCHITECTURE.md),
правила агента — в корневом `AGENTS.md`.

## Начало работы

Нужны Node.js 22+, npm и Git. EDT не требуется для изменения Node.js-кода
и локальных регрессий. Необходимое внешнее окружение подключается отдельно
для live-проверок интеграций.

```sh
git clone https://github.com/ShadobaAI/edt-ai-core.git
cd edt-ai-core
npm ci --ignore-scripts
node tools/vendor.mjs
```

`vendor.mjs` собирает runtime-библиотеки из lockfile в `vendor/deps.mjs`,
копирует готовые Windows-модули Koffi и формирует `vendor/NOTICE.txt`.
Каталог `vendor/` генерируется и не хранится в Git. Изменяя зависимости,
обновляйте `package.json`, lockfile и проверяйте сведения о лицензиях.

| Что менять | Где искать |
| --- | --- |
| Подключения Codex | `plugin.json`, `mcp.json`, `hooks/hooks.json` |
| Профиль и его загрузку | `schemas/`, `scripts/profile.mjs`, `project_context.mjs`, `selection.mjs` |
| Форму и настройки | `ui/settings.html`, `mcp/settings.mjs`, `scripts/settings_backend.mjs` |
| Запуск и обновление MCP | `scripts/runtime.mjs`, `lazy_mcp.mjs`, `mcp/bsl-ls-proxy.mjs` |
| Правила работы агента | `skills/`; принятые границы — `skills/catalog.yaml` |
| Нормативный протокол и guard | `policy/`, `scripts/guard.mjs`, `hooks/` |
| Поставку | `scripts/package_layout.mjs`, `tools/package-plugin.mjs`, `tools/check-plugin.mjs` |

## Проверки

Запускайте регрессии изменённого модуля, например:

```sh
node --test tests/test-profiles.mjs tests/test-profile-settings.mjs
```

Полный набор:

```sh
node tools/test.mjs
```

`npm test` дополнительно вызывает vendor-сборку через `tools/develop.mjs`.
Тестовый runner использует Node без shell/glob expansion. Фикстуры проверяют
схемы, изоляцию, API, ошибки и упаковку; они не подтверждают фактическую
приёмку установленного EDT, v8std, JAR, тестовых баз и UI Codex.
Карта регрессионных и поведенческих проверок и их ограничения:
[ACCEPTANCE.md](ACCEPTANCE.md). Поведенческие сценарии выполняются отдельно
по `tests/behavioral/README.md`; Node runner не выдаёт их за автоматические тесты.

Для документации сверяйте команды и поля с реализацией, проверяйте ссылки
и примеры YAML. Для changes в составе поставки проверяйте оба архива и
извлечённый плагин. Сборка не является обязательным завершением каждой задачи.

## Локальная сборка

После установки dev-зависимостей выполните:

```sh
bash tools/build-plugin.sh
```

На Windows можно использовать Git Bash. Обёртка запускает только
`vendor.mjs` и `package-plugin.mjs`; при интерактивном запуске ждёт Enter
перед закрытием. Она не запускает тесты и ничего не публикует.
Эквивалент без Bash:

```sh
node tools/vendor.mjs
node tools/package-plugin.mjs
```

Сборщик проверяет входы, затем заменяет `.build/`. Не храните в ней нужные
ручные файлы. Результат:

```text
.build/
  marketplace/
    .agents/plugins/marketplace.json
    plugins/1c-ai-core/
  1c-ai-core-VERSION.zip
  1c-ai-core-VERSION-marketplace.zip
  SHA256SUMS
```

Первый ZIP содержит плагин в каталоге `1c-ai-core/`, второй — корень магазина
с каталогом `.agents/plugins/` и готовым пакетом. Внутри плагина сборщик
создаёт `.codex-plugin/plugin.json`, `build-info.json` и `SOURCE.md`.

Локальная версия выбирается как максимальная из версии `plugin.json`
и стабильных tags, достижимых из HEAD. Её можно задать явно:
`node tools/package-plugin.mjs --version 0.3.1` (пример версии).
Для tag-сборки CI версия обязана совпадать с tag. Сборщик не меняет
manifest исходников и отмечает dirty-состояние в build-info/SOURCE.

Проверьте извлечённый пакет:

```sh
node tools/check-plugin.mjs .build/marketplace/plugins/1c-ai-core
```

Проверка запускает MCP из готового пакета с Node-only окружением,
проверяет manifest, bundled-зависимости, лицензии и профильные операции.
Проверка извлечённого пакета также загружает поставляемые схемы знаний,
валидирует изолированный Markdown-каталог и форму подтверждения публикации,
проверяет отказ старой версии профиля. `schemas/*.json` включаются действующим
правилом package layout; smoke-matrix CI выполняет эту же проверку на Node 22/24
в Windows, Linux и macOS. Это локальная проверка контракта, без live-приёмки
OpenViking и без включения внешнего поиска.
Для проверки контрольных сумм ZIP и извлечения используйте
`node tools/verify-package.mjs .build .work/verified-package`;
путь вывода должен быть новым. После извлечения можно проверить
`.work/verified-package/plugins/1c-ai-core` тем же `check-plugin.mjs`.

Установите готовый магазин в Codex:

```sh
codex plugin marketplace add ./.build/marketplace
```

Затем установите плагин из этого источника. Codex использует установленную
копию в кэше, поэтому изменение исходников само по себе не обновляет
работающий плагин. После пересборки обновите локальный источник/установку
и перезагрузите её средствами хоста.

## Состав и лицензии пакета

Allowlist определяет `scripts/package_layout.mjs`. Пакет содержит runtime,
навыки, схемы, документацию, generic-профиль, vendor bundle и лицензии.
Не содержит `tools/`, `tests/`, `node_modules/`, Git, проектные профили,
локальные настройки и состояние пользователя. Bash-обёртка остаётся
в исходниках и не поставляется пользователю.

Обязательно сохраняются `LICENSE` (MPL 2.0), `NOTICE.md`,
`UNICODE-LICENSE.txt`, сгенерированные `vendor/NOTICE.txt` и `SOURCE.md`.
Сторонние компоненты сохраняют свои лицензии; сведения о происхождении
нельзя заменять общей лицензией плагина.

## CI и публикация

Workflow `build-plugin.yml` запускается для pull requests, push в `develop`
и стабильных числовых tags вида `0.3.1` без префикса `v`. Другие push веток
его не запускают.
CI устанавливает dev-зависимости, собирает vendor, запускает регрессии,
проверяет ZIP и публикует artifact `1c-ai-core-plugin`. Затем smoke-matrix
проверяет извлечённый пакет на Windows/Linux/macOS с Node 22 и 24.

Сборка push в `develop` создаёт отдельный плагин `1c-ai-core-preview`
с названием `1C AI Core Preview` и версией, например, `0.4.3-preview.1`.
Базовая версия берётся из `plugin.json`; номер считает все push-запуски
сборки `develop` этой версии, включая неудачные. Повторный запуск сохраняет
номер, при изменении базовой версии счётчик начинается с 1. Для вычисления
нужны история workflow GitHub Actions и исходные коммиты этих запусков;
не удаляйте историю запусков и не переписывайте историю `develop`.
Совместимость профилей Preview проверяется по базовой версии.

`publish-marketplace.yml` получает успешную tag- или develop-сборку после завершения
всего workflow, проверяет её происхождение, revision, версию, run ID,
контрольные суммы и отсутствие dirty-состояния. Доверенные publication tools
берутся из main. Публикация обновляет только `ShadobaAI/codex-plugins`,
сохраняя остальные записи магазина и запрещая откат версии каждого канала.
Сборки могут завершаться не по порядку: более старый Preview не заменит более
новый, даже если его проверки завершились позже. Stable и Preview находятся
в магазине параллельно как независимые записи.

Для публикации нужен `MARKETPLACE_TOKEN` с Contents write к репозиторию
магазина. Это CI-секрет; пользователь плагина его не настраивает.
Ручной запуск публикации принимает ID успешной tag- или develop-сборки.
Для работы `workflow_run` обновлённый workflow и publication tools должны
находиться в ветке по умолчанию `main`; до их переноса в `main` новый Preview
не будет автоматически опубликован. Создание stable tag выполняется отдельно.
