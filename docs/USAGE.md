# Использование 1C AI Core

## Пользовательская проверка

Откройте карточку локального плагина в Codex, установите его и перейдите в настройки.
Нажмите «Импорт настроек», выберите экспорт настроек вашего проекта,
проверьте папку проекта и подтвердите импорт. Профиль и экспорты
конкретного проекта хранятся в его репозитории или вне каталога плагина.
После импорта запускается подготовка и проверка MCP. Для доступа к инструментам
откройте эту папку проекта в Codex: ручной выбор папки в настройках относится
только к текущей сессии настроек. Python-зависимости подготавливаются внутри плагина.

В настройках также доступны «Экспорт настроек», «Подготовить и проверить MCP»
и «Состояние операции». Интерфейс использует structured settings и MCP App.
Нативная карточка Codex в рамках этой проверки визуально не принималась.
Границы проверок и lifecycle операций описаны в [NATIVE_SETTINGS.md](NATIVE_SETTINGS.md).
Архитектурный разбор, ограничения и дальнейшие изменения — в
[SETTINGS_REVIEW.md](SETTINGS_REVIEW.md).

Далее описаны CLI-инструменты для сопровождения и тестирования.

В `1c-code-change` включён [recovery отказа EDT model gate](../skills/1c-code-change/references/edt-recovery.md),
подтверждаемого по фактическому контракту сервера. Он использует назначенный EDT любого проекта:
адресную revalidation и ограниченные повторы только при доказанном отказе до
записи; cleanup требует согласования своего scope. Это workflow навыка, а не
автоматический retry транспорта. Применимость к установленному EDT проверяется
отдельно; timeout записи повтор не разрешает.

Рабочий локальный CLI/MCP-прототип универсального ядра для 1С.
Проект использует свой переносимый профиль; конкретные пути, EDT-проекты
и aliases задаются явно. В поставке есть только универсальный шаблон
`profiles/generic-1c/`; проектные профили разрабатываются отдельно.

| Компонент | Владение и запуск |
| --- | --- |
| EDT | Обязательный внешний MCP; пользователь запускает и указывает URL |
| v8std | Обязательный внешний MCP; пользователь запускает и указывает URL |
| policy | Встроенный read-only MCP на Node: требования, ledger и проверка scope/effects согласований |
| code-index | Плагин скачивает, проверяет SHA-256, запускает project daemon |
| BSL LS | Плагин скачивает JAR, проверяет SHA-256, запускает MCP на время сессии |
| Vanessa CLI | Встроенный адаптер; платформу и Vanessa runtime предоставляет пользователь |
| OpenViking | Планируемая интеграция; сохранённый флаг/URL не подключают провайдер |

Code-index использует отдельный `CODE_INDEX_HOME`, конфиг, PID и автоматически
выбранный loopback-порт для каждого канонического корня repo-local профиля.
Все явно указанные в нём конфигурации получают свои aliases. Разные каталоги
работают параллельно; запуск их демонов не удерживает общий lock установки.
Сессии одного корня переиспользуют его демон, но открывают отдельные MCP readers:
отсев повторной выдачи одной сессии не скрывает данные от другой. Смена каталога
и отключение reader не останавливают демон, нужный другой сессии. Остановка
действует только на демон выбранного профиля с проверкой ownership. Смена mapping
у работающего демона отклоняется до его явной остановки; чужие binding не меняются.

Навык [1c-code-index](../skills/1c-code-index/SKILL.md) выбирает возможности по задаче,
используя живые schema без фиксированного перечня инструментов. Краткие обзоры,
секции, графы, адресные диапазоны и continuation уменьшают объём контекста;
специализированные маршруты покрывают также формы, права, проведение и СКД.
Локальный proxy переиспользует раскрытые schema до уведомления об их изменении;
явный запрос host обновляет полную поверхность с учётом страниц. Payload, markers
усечения и отсева повторов передаются без фильтрации.

KORA — будущий план. Отсутствие OpenViking не блокирует ядро.

Платформенную справку предоставляет назначенный EDT через `1c-platform-docs`.
HelpSearchServer (`1c-docs-mcp`) исключён из поставки и маршрутов ядра, включая
дополнительное подключение. Принятое решение и его основания записаны в
[skills/catalog.yaml](../skills/catalog.yaml), `platform-documentation-edt-only`.
Нормативный текст остаётся в `v8std`. Пробелы справки EDT явно отмечаются;
наличие сигнатуры не считается доказательством defaults, контекстов или истории версий.

`1c-ssl-mcp` также исключён, включая дополнительное подключение и fallback:
решение `bsp-documentation-without-ssl-mcp` в том же каталоге следует KORA D-01
и §7.3. Отсутствие обоих legacy MCP не является дефектом миграции. Целевая
замена справки БСП базой знаний/OpenViking требует отдельной реализации и приёмки.

Нормативный workflow задаётся в [1c-standards](../skills/1c-standards/SKILL.md).
Живые возможности v8std, компактное чтение и границы повторного использования
описаны в [MCP-контракте](../skills/1c-standards/references/mcp.md). Один read-only
сервер можно использовать параллельно в разных проектах. У каждого клиента
свои binding, подбор по коду/контексту и оценки соответствия; общего кэша
ответов между клиентами нет. Адрес и редакция сервера не зашиваются в навыки.
`v8std_explain_snippet` подбирает кандидатов по затронутым методам/запросам,
`v8std_get_requirements_for_context` — по design/metadata и условиям вне кода.
Агент проверяет применимость по точному тексту; `policy` объединяет baseline
реестра с дополнительными применимыми нормами в одном selection/ledger.
Предложение до записи и фактический
результат проверяются разными ledger с явными фазами `proposal`/`result` и
сохранённым selection digest. [Policy 2.1](../policy/README.md) принимает явные
assessments вместо sourceText и связывает ledger с target и источником текущей
фазы. `ledger_valid` подтверждает согласованность заявлений; `blocked` сохраняет
нарушения/непроверенные нормы. Run/report-only возвращает `not_applicable`
без compliance selection. Неизвестные critical механизмы, неполное coverage и stale
selection не дают успешного compliance. Сам policy не читает проектные исходники,
не обращается к v8std и не доказывает истинность оценок агента. Применимость
выбранных текстов проверяется агентом. Подбор по коду проверен на живом v8std;
он возвращает кандидатов, не гарантирует полноты и не запускает analyzer.
Приёмка всего корпуса и реального изменения остаётся отдельной проверкой.

Исходники ИИ-окружений CRM/Kafka доступны через их репозитории:
см. [SOURCES.md](SOURCES.md). В репозитории плагина хранятся универсальные
реализации и шаблоны профилей; архивных копий проектных окружений нет.

## Запуск

Нужны Windows x64, Python 3.12+, Node.js 18+ и Java 25+. Настройки Java/Node
можно переопределить; пути к code-index и BSL LS пользователь не задаёт.

Из корня репозитория:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts/profile.py init C:\path\to\project --profile generic-1c
```

Проект должен уже существовать. Init создаёт `.ai/project.yaml`,
`.ai/PROJECT.md` и отсутствующий `AGENTS.md`. Существующие инструкции не заменяются.
В проектном `AGENTS.md` опишите границу продукта поставщика и собственных
доработок, соответствия префиксов/пространств имён, правила изменения поставки,
именования и маркировки. Продукт поставщика включает встроенные библиотеки и
добавленные самим вендором объекты с его префиксами. Общий механизм определения
принадлежности и применения этих правил находится в `1c-code-change`.
В `.ai/project.yaml` явно заполните список:

```yaml
repositories:
  - id: product
    path: .
    alias: product
    edt_project: MyEdtProject
roots:
  source: [src]
  protected: [src]
```

Пути относительные, внутри корня проекта; aliases уникальны. Пустые профили
можно переносить, но запуск без явного repository mapping отклоняется.
BSL LS принимает несколько конфигураций через штатную регистрацию workspace;
выбор единственного репозитория при запуске не требуется.

## Настройки плагина

Плагин загружает ближайший `.ai/project.yaml` из выбранного каталога, останавливаясь
на границе другого Git-репозитория. Каждый независимо выбранный проект имеет
свой профиль; его экземпляры могут использовать один repo-шаблон.
При смене MCP roots профиль подгружается заново в текущей сессии. Изменение
другой сессией глобального `active_project` не переключает выбранный каталог.

Для каждой независимо выбранной конфигурации/каталога нужен свой запущенный
пользователем EDT-MCP и effective URL. Связанные база и расширения одного профиля
могут использовать явно сопоставленные проекты одного EDT workspace. Отдельная
MCP-сессия не изолирует общий debugger, profiling или comparison state. Перед
работой проверяются точные имя, путь и вид назначенного проекта. Проверка
MCP после подготовки переподключает только выбранный каталог/экземпляр.

В репозитории хранятся defaults подключений, например:

```yaml
connections:
  edt:
    url: http://127.0.0.1:8765/mcp
    url_env: EDT_AI_EDT_URL
  v8std:
    url: http://127.0.0.1:8000/mcp
```

Это пример, а не обнаруженные адреса: замените его своими URL. Credentials в URL не поддерживаются.
`url_env` необязателен: по умолчанию используются `EDT_AI_EDT_URL` и
`EDT_AI_V8STD_URL`. Профиль — шаблон; его не нужно менять ради второго экземпляра.

Приоритет URL от высшего к низшему:

1. Переменная окружения процесса (`url_env` или стандартное имя).
2. Явный `EDT_AI_CONNECTIONS_FILE` с object `connections`.
3. Override текущего экземпляра в Codex:
   `CODEX_HOME/1c-ai-core/projects/<directory-key>/instances/<instance>.yaml`.
4. Repo-local `.ai/instances/<instance>.local.yaml`.
5. Общий локальный `.ai/project.local.yaml`.
6. Tracked `.ai/project.yaml`; старые plugin URL settings — compatibility fallback.

Legacy EDT URL, принадлежащий другому `active_project`, не подставляется в
выбранный каталог. Для параллельной работы задавайте проектный/instance URL;
общая переменная процесса с одним URL не выбирает разные EDT автоматически.

Локальные файлы могут содержать тот же object `connections` и проверяются отдельной
схемой. Конфигурации BSL LS выбираются в запросах своей сессии; поле
`selected_repository` и CLI `--repository` удалены.
Локальные файлы не могут менять policy и другие поля шаблона. Init добавляет
ignore patterns для local overrides. `EDT_AI_INSTANCE` задаёт имя экземпляра
(по умолчанию `default`); разные процессы Codex могут задать разные имена/URL.
`EDT_AI_PROJECT_ROOT` явно закрепляет каталог для CLI или отдельной сессии.
Если явно заданный `EDT_AI_CONNECTIONS_FILE` отсутствует, подключение блокируется.

```powershell
$env:EDT_AI_INSTANCE = 'crm-second'
$env:EDT_AI_EDT_URL = 'http://127.0.0.1:18765/mcp'
python scripts/profile.py effective C:\project
```

Переменные передаются процессу Codex при его запуске. Для сохранённого значения
экземпляра вместо переменной используйте настройки плагина или:

```powershell
python scripts/profile.py configure-instance C:\project --instance second --edt-url http://127.0.0.1:18765/mcp
```

`effective` показывает применяемый профиль и путь instance override; чтение
само по себе файлов не создаёт. Применяемый профиль собирается в памяти;
сохранённый файл содержит overrides подключений. Например:

```yaml
connections:
  edt:
    url: http://127.0.0.1:18765/mcp
```

Редактирование URL в настройках сохраняет override
экземпляра в Codex ещё до создания профиля и не меняет tracked шаблон.
Без выбранной папки сохранение URL отклоняется. До инициализации профиля выбранный
подкаталог Git нормализуется до корня этого репозитория, чтобы ключ привязки
сохранился после инициализации. Пустой URL явно отключает подключение в override;
он не удаляет override и не восстанавливает default. Переменная процесса сохраняет высший
приоритет. Общие Node/Java/runtime defaults находятся только в `settings/defaults.json`;
`--settings`/`EDT_AI_SETTINGS` задают совместимые общие настройки.
BSL LS использует `register_workspace_folder`, `list_workspace_folders` и
`unregister_workspace_folder`. Регистрации принадлежат текущей stdio-сессии.

Установочная сборка пишет `settings.json`; существующий `settings.yaml`
подхватывается при подготовке, если JSON ещё нет. Settings MCP и CLI используют
общий Python reader для JSON/YAML. Выбранный подкаталог нормализуется до ближайшего
корня профиля одинаково для чтения, импорта и экспорта, с сохранением Git-границ.

## Импорт и экспорт

Экспорт переносит общий settings bundle и tracked defaults профиля. Local/instance
overrides и process environment в файл не подставляются; параметры конкретного
экземпляра сохраняются отдельно. Общий `active_project` и legacy URL settings
в новых native exports отсутствуют. URL из старого settings bundle импортируются
в override выбранного экземпляра; пустой legacy URL означает отсутствие fallback.
Native settings не меняет сохранённый CLI `active_project`: выбранная папка
принадлежит сессии. Регистрации BSL LS в экспорт не входят.

```powershell
python scripts/profile.py export C:\project --output profile.yaml
python scripts/profile.py import C:\other-project --input profile.yaml
python scripts/profile.py import C:\other-project --input profile.yaml --merge
python scripts/profile.py import C:\other-project --input profile.yaml --replace
python scripts/profile.py validate profile.yaml
```

Используйте Python из подготовленного venv. Команды возвращают JSON и ненулевой
код при ошибке. Проверяются JSON Schema, типы, версия, неизвестные поля,
повторяющиеся YAML-ключи, относительные пути, уникальность IDs/aliases и связи
между capabilities и репозиториями. Import и settings preview/apply дополнительно
проверяют разрешённые пути относительно конкретного корня, включая symlinks.
Merge рекурсивно объединяет objects,
массивы заменяет целиком; разные profile_id объединять нельзя.
Замена существующего профиля требует явного флага и сохраняет `*.bak.yaml`.
Ошибочный импорт не меняет действующий файл. Экспорт без `--replace` не
перезаписывает готовый файл. Поля credentials отклоняются.

## Тестовые capabilities и согласования

`testing.yaxunit` и `testing.vanessa` — boolean. Включённая возможность требует
типизированного binding. Например, для репозиториев `product`, `tests` и
`framework` (каждый уже описан в `repositories`, у `tests` заданы `path: tests`
и `edt_project`):

```yaml
testing:
  commands: []
  yaxunit: true
  yaxunit_config:
    repository_id: tests
    framework_repository_id: framework
    product_repository_ids: [product]
    runner: edt
    results: results/unit
  vanessa: true
  vanessa_config:
    repository_id: tests
    runtime_profile: .ai/vanessa.local.json
    features: tests/features
    results: results/ui
    server_name: vanessa
```

Пути заданы от project root; `features` должен находиться внутри репозитория
владельца. YaXUnit core и владелец тестов — разные репозитории, enabled YaXUnit
требует связанный EDT project. Commands описываются объектами с `id`,
`repository_id`, `argv` (массив аргументов), `effects` и необязательным
`timeout_seconds`; validation не исполняет команды. Точный контракт находится в
[project-profile.schema.json](../schemas/project-profile.schema.json).
Неизвестные поля и старые произвольные значения отклоняются с ошибкой;
автоматического угадывания новых bindings нет.

Общие согласования хранятся в [policy/default.json](../policy/default.json).
Проект не может отключить обязательные группы или разрешить shell-доступ к
protected source. Effective policy видна через `scripts/action_policy.py PROJECT`,
doctor, settings connection check и MCP `get_action_policy`/`check_action`.
Все навыки используют один [контракт согласований](../skills/1c-routing/references/action-policy.md).
Фактическое указание пользователя переиспользуется для того же scope/effects;
локальный checker проверяет переданные утверждения, а не личность пользователя.
Host approvals остаются отдельным механизмом.

В поставку включён `hooks/guard.mjs`, зарегистрированный как `PreToolUse` в
manifest. Он проверяет protected source и index aliases выбранного проекта.
Для выполнения plugin hooks Codex требует доверие пользователя к плагину;
наличие файлов не подтверждает активацию hook. Doctor отдельно показывает
`packaged` и `host_trust/host_activation: not_verified`. Это ограничитель
маршрутов, а полнота изоляции зависит от host sandbox. См.
[официальный контракт hooks](https://developers.openai.com/plugins/build/plugins).

YaXUnit выполняется через назначенный EDT по
[полному workflow](../skills/yaxunit-tests/SKILL.md). Для Vanessa локальный runtime
JSON соответствует [отдельной схеме](../schemas/vanessa-runtime.schema.json) и задаёт
платформу, manager/TestClient, runtime и endpoint. Его машинные параметры не
экспортируются внутри переносимого профиля. Привязки project/features/results и
имя сервера должны точно совпадать с portable binding.

```powershell
python scripts/vanessa.py describe --project-root C:\project --feature tests/features/example.feature --scenario 'Exact scenario'
python scripts/vanessa.py doctor --project-root C:\project
python scripts/vanessa.py run --project-root C:\project --feature tests/features/example.feature --scenario 'Exact scenario' --authorization-file actual-agreement.json
```

`describe` только показывает точные `scope` и `effects`. Формат authorization
record и editor transition описаны в [CLI workflow](../skills/vanessa-ui-tests/references/cli-workflow.md);
запись evidence создаётся только по реальному разрешению человека.
Относительный `--feature` считается от project root; разрешены как настроенная
папка features, так и временная `.local/repair.feature` внутри проекта.
`describe` и `run` одинаково проверяют расширение и границу проекта.
Bundled wire adapter проверен на Vanessa Single 1.2.043.45 / MCP 1.31;
неизвестная версия блокирует зависимую операцию. Run сохраняет receipt со статусом
`unverified`: итог теста требует проверки actual results того же запуска.

## Runtime и MCP

EDT используется по возможностям текущего сервера без привязки к его исходному
репозиторию, фиксированной версии или списку операций. Общий [контракт](../skills/1c-routing/references/toolsets.md)
определяет binding, компактные ответы и раскрытие только нужных групп. Обычные
вызовы переиспользуют каталог; явный discovery обновляет его и без push-событий.
Сценарии отладки/замера и специализированных артефактов загружаются по задаче,
а внешняя AI-помощь не расходует лимит автоматически. Покрытие workflow не
означает live-приёмку всех возможностей установленного EDT.

```powershell
python scripts/runtime.py install all
python scripts/runtime.py smoke all --project-root C:\project
python scripts/runtime.py start code-index --project-root C:\project
python scripts/runtime.py start bsl-ls --project-root C:\project
python scripts/runtime.py stop code-index --project-root C:\project
python scripts/runtime.py status --project-root C:\project
```

Install необязателен: MCP entrypoints сами устанавливают отсутствующий runtime.
BSL LS запускается через `java -jar ... mcp`; адаптер ограничивает доступ выбранным
каталогом проекта. Этот каталог — граница доступа, а не автоматически индексируемый
workspace. Codex получает пути конфигураций через назначенный EDT-MCP
(`list_projects` со структурированным ответом), затем передаёт точный корень каждой
нужной конфигурации в `register_workspace_folder`. `list_configurations` EDT
описывает конфигурации запуска и не заменяет получение путей исходников.

BSL LS может держать несколько workspace: файловые операции выбирают контекст по
пути, остальные принимают `workspaceFolder` из результата регистрации/списка.
Переключение между зарегистрированными конфигурациями не перезапускает JVM и не
меняет другие сессии Codex. Требуется нативный API регистрации workspace; отсутствие
этого API обнаруживается при подключении и проверке готовности, без fallback.

Параметр `mcp.managed.bsl-ls.configuration` необязателен: относительный путь
разрешается от выбранного project root, абсолютный передаётся явно. Файл
`bsl-language-server.json` без точки используется, когда указан этим параметром.
Явный файл передаётся как `--configuration` и `app.configuration.path`, чтобы
BSL LS применил глобальные и workspace-параметры. Без него сервер сам ищет
`.bsl-language-server.json`: рабочий каталог процесса, каталог workspace, затем
домашний каталог пользователя. Найденный раньше файл имеет приоритет, настройки
не объединяются прокси. Пустой конфиг не создаётся. Unicode-пути и file URI
нормализуются без требования Windows 8.3.
`start bsl-ls` — foreground stdio MCP, поэтому ожидает MCP-клиента.
Code-index daemon остаётся после отключения клиента и останавливается отдельной
командой. BSL LS закрывается вместе с сессией; orphan-процессы проверены.

По умолчанию state хранится в `CODEX_HOME/1c-ai-core` (или `~/.codex/1c-ai-core`).
Для тестов используйте `--state-dir .work/state`.
Для отдельного процесса `EDT_AI_STATE_DIR` выбирает тот же state для runtime и
overrides; явный `--state-dir` у CLI имеет приоритет над этой переменной.
Runtime version и SHA-256
записываются в `runtime-lock.json`. Повторный запуск использует проверенный
локальный runtime без сети. `install --refresh` явно проверяет новый релиз;
при изменении code-index сначала остановите daemon. Первое скачивание требует
доступа к GitHub. Нет скрытого fallback на повреждённый артефакт.

Переносимый `mcp.json` содержит settings, встроенный `policy` и четыре lazy
entrypoints: EDT, v8std, code-index и BSL LS. Они выбирают профиль текущей сессии.
У v8std локальный `core_runtime_status` остаётся доступным после подключения и
возвращает binding и согласованные инструкции/capabilities сервера; это не
live-приёмка полноты корпуса. Обычные вызовы переиспользуют discovery, не меняют
payload сервера и не запускают повторный tools/list. Timeout чтения v8std —
60 секунд; переподключение не повторяет автоматически прерванный запрос.
Для подключения managed, bundled policy и внешних MCP к host с нужным
Python/проектом сформируйте конфигурацию:

```powershell
python scripts/runtime.py config --project-root C:\project --output mcp.local.json
```

Конфигурация использует текущий Python, абсолютные пути и реальные URL из
настроек. Генерация файла не устанавливает плагин и не меняет конфигурацию Codex.
Авторизация и native installer остаются отдельным этапом.

## Doctor

```powershell
python scripts/doctor.py C:\project
python scripts/doctor.py C:\project --live
python scripts/doctor.py C:\project --live --managed-only
```

Static doctor проверяет конфигурацию и локальные hashes. Live проверяет bundled
policy через MCP и запускает initialize/tools/list для managed серверов;
может скачать недостающие runtime. Для code-index дополнительно требуется
подтверждённый `index_ready=true`: aliases должны точно соответствовать путям
профиля, каждый repository — сообщить ready и явно подтвердить свежесть данных.
Отсутствующие поля, чужой путь или ещё выполняющаяся индексация дают `status: error`
и ненулевой код завершения CLI. Это проверка объявленной готовности; полнота
конкретного слоя, exclusions и ограничения поиска проверяются по его ответу.
`--managed-only` допускает отсутствие внешних URL только для изолированной
проверки. Поле `full_development_readiness` остаётся `not_verified`: live
приёмка EDT/v8std пока не реализована.

## Проверки

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_*.py -v
node tests/test-vanessa-ui.mjs
.\.venv\Scripts\python.exe tests/prepare_live.py .work/demo-project
.\.venv\Scripts\python.exe tests/live_smoke.py --project-root .work/demo-project --state-dir .work/state --output .work/live-result.json
```

Live smoke использует реальные host entrypoints: скачивание при отсутствии
артефактов, MCP handshake, индексирование и поиск функции, символы и диагностику
BSL LS, отказ читать вне root. Выполняется на синтетических исходниках.
Результаты приёмки — в `VERIFICATION.md`; незавершённое — в `ROADMAP.md`.

