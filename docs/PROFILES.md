# Профили проектов

Профиль связывает универсальные навыки плагина с конкретным проектом:
репозиториями, индексными aliases, проектами EDT, защищёнными путями
и тестовыми возможностями. Это данные YAML, а не исполняемый адаптер.
`project.adapter` — описательная метка; она не загружает проектный код.

## Какие файлы за что отвечают

```text
project/
  AGENTS.md                  инструкции Codex
  .ai/
    PROJECT.md               назначение, архитектура и источники истины
    project.yaml             переносимый профиль
    project.local.yaml       личные overrides, вне Git
    instances/
      dev.local.yaml         overrides именованного экземпляра, вне Git
  src/                       пример каталога исходников
```

Профиль и инструкции храните в Git проекта. Личные overrides и резервные копии
с адресами/параметрами окружения не публикуйте. `profile init` создаёт `.ai/.gitignore`
для `project.local.yaml` и `instances/*.local.yaml`; правила для резервных копий
при необходимости добавьте сами.

Отдельно плагин хранит пользовательское состояние в `${CODEX_HOME}/1c-ai-core`
(по умолчанию `~/.codex/1c-ai-core`): общие настройки, загруженные runtime,
индексы, историю, диагностику и overrides экземпляров. Оно не переносится
в репозиторий и не входит в установочный ZIP.

## Создание через чат

Откройте папку проекта и попросите: **«Создай и настрой профиль 1C AI Core»**.
Агент создаст шаблон `generic-1c`, уточнит только недостающие сопоставления
и поможет проверить подключения. Существующий профиль не перезаписывается
командой создания; для изменения используется редактор или импорт с предпросмотром.

При создании добавляются только отсутствующие `AGENTS.md`, `.ai/PROJECT.md`
и `.ai/.gitignore`. Их минимальный текст требует заполнения под ваш проект:
[как подготовить проектный AGENTS.md](PROJECT_AGENTS.md#как-создать).
Создание возвращает списки добавленных/сохранённых инструкций и
`contentValidated: false`; это не проверка полноты правил команды.
Существующий `AGENTS.override.md` сохраняется и включается в `preserved`;
если он непустой, поле `overrideFile` сообщает о его приоритете над `AGENTS.md`.
Каталоги вместо вспомогательных файлов отклоняются до записи профиля.

## Минимальный заполненный профиль

Ниже пример для одного репозитория с исходниками в `src/`. Имя `Application`
нужно заменить точным именем проекта в EDT; остальные значения тоже относятся
к примеру, а не к встроенному проекту плагина.

```yaml
schema_version: '0.1'
profile_id: generic-1c
profile_version: 0.1.0
project:
  id: application
  adapter: generic-1c
  purpose: Разработка прикладной конфигурации
repositories:
  - id: application
    path: .
    alias: application
    edt_project: Application
roots:
  source: [src]
  protected: [src]
authorities:
  edt_writer: edt
  code_index: code-index
  bsl_ls: bsl-ls
  v8std: v8std
policy:
  mode: conservative
  edt_repository_ids: [application]
testing:
  commands: []
  yaxunit: false
  vanessa: false
knowledge:
  mode: disabled
  provider: none
  manifest: null
  collections: []
  required: false
  dependent_actions: []
compatibility:
  core: '>=0.1.0'
```

Контракт проверяет [project-profile.schema.json](../schemas/project-profile.schema.json),
дополнительные ограничения — [profile.mjs](../scripts/profile.mjs).

| Поле | Назначение |
| --- | --- |
| `schema_version` | Версия структуры данных; сейчас строка `'0.1'` |
| `profile_id`, `profile_version` | Идентификатор и версия переносимого профиля; `project.id` отдельно идентифицирует проект |
| `repositories[].id` | Уникальная ссылка на репозиторий в policy и testing |
| `repositories[].path` | Путь от каталога профиля до корня репозитория |
| `repositories[].alias` | Уникальное имя для code-index |
| `repositories[].edt_project` | Точное имя проекта EDT; `null` допустим в схеме для репозитория без назначения |
| `roots.source`, `roots.protected` | Каталоги, закрытые для общего filesystem/shell-доступа; guard использует объединение списков |
| `authorities` | Назначенные роли: EDT writer, code-index, BSL LS и v8std |
| `policy` | Привязка EDT-репозиториев и дополнительные ограничения/нормативные исключения |
| `testing` | Команды и настройки YaXUnit/Vanessa; включённый вид тестов требует соответствующего config |
| `knowledge` | Режим, провайдер, manifest, collections, обязательность и зависимые фазы; поисковый адаптер OpenViking — **планируется** |
| `compatibility.core` | Требование к версии запущенного ядра, проверяемое при загрузке |

Пути должны быть относительными, без `..` и выхода за корень проекта,
включая выход через symlink/junction. IDs и aliases репозиториев уникальны.
`edt_repository_ids` и `unbound_edt_repositories` ссылаются только на известные
репозитории и не пересекаются. Неизвестные поля отклоняются схемой.
Проектные исключения норм не отменяют общую action policy или защиту исходников.

## Несколько репозиториев

Разместите профиль в общем корне рабочего пространства, а все репозитории —
внутри него. Например: `product/`, `unit-tests/`, `framework/`, `ui-tests/`.
Для каждого задайте отдельные `id`, `path`, `alias` и соответствующее EDT-имя.
Не используйте `../sibling`: такой путь не пройдёт проверку.

Плагин ищет профиль в выбранном каталоге и выше до границы Git. Если его нет,
проверяет вложенные каталоги. Один найденный профиль может быть выбран,
несколько дают неоднозначность: откройте конкретную папку. Discovery пропускает
служебные каталоги, symlinks и дерево `src` у найденного EDT-проекта;
не стоит размещать профиль внутри исходников конфигурации.

Несколько репозиториев в одном профиле обслуживает его назначенный EDT endpoint.
Для независимо выбранных контуров используйте отдельные профили/экземпляры
и серверы EDT. Пример структуры —
[multirepo-workspace](https://github.com/ShadobaAI/edt-ai-core/tree/main/examples/multirepo-workspace).

## Подключения и экземпляры

`connections.edt` и `connections.v8std` в переносимом профиле необязательны.
Публичные безопасные defaults можно хранить там; машинные адреса удобнее
задавать через форму или `.ai/project.local.yaml`.

Пример **локального** файла; адреса условные, их нужно заменить:

```yaml
connections:
  edt:
    url: http://127.0.0.1:18080/mcp
  v8std:
    url: http://127.0.0.1:18081/mcp
    headers_env:
      Authorization: V8STD_AUTHORIZATION
components:
  bsl-ls:
    enabled: false
```

В `V8STD_AUTHORIZATION` передаётся полное значение заголовка, например
`Bearer …`. Значения секретов не записывайте в YAML или URL.
Локальный формат проверяет [project-local.schema.json](../schemas/project-local.schema.json).
Он поддерживает `connections` и overrides `components` для code-index/BSL LS;
это не второй переносимый профиль.

Порядок наложения от меньшего приоритета к большему:

1. Общие defaults и пользовательские настройки плагина.
2. `connections` из `.ai/project.yaml`.
3. `.ai/project.local.yaml`.
4. `.ai/instances/<instance>.local.yaml`.
5. Пользовательский файл `projects/<project-key>/instances/<instance>.yaml`
   в каталоге состояния плагина.
6. Файл из `EDT_AI_CONNECTIONS_FILE`.
7. Переменная `url_env` подключения либо стандартная `EDT_AI_EDT_URL`
   / `EDT_AI_V8STD_URL`.

Объекты объединяются по полям, массивы заменяются целиком. Явная пустая строка
локального URL отключает подключение и не заменяется автообнаружением.
Если EDT URL не задан, плагин может получить его из настроек workspace EDT.
Старый общий EDT URL применяется только при совпадении владельца `active_project`.

Имя экземпляра задаёт `EDT_AI_INSTANCE`, по умолчанию `default`.
Так один каталог может иметь разные локальные подключения. Переключение
экземпляра/подключения инвалидирует зависимый контекст этой MCP-сессии.
Один read-only v8std можно использовать нескольким проектам.

## Тесты и знания

Для YaXUnit укажите `testing.yaxunit_config`: репозиторий тестов,
`runner: edt`, каталог результатов и при необходимости framework/product mappings
и launch configuration. Включённому YaXUnit нужен назначенный EDT-проект
владельца тестов; framework и владелец тестов — разные репозитории.

Для Vanessa укажите `testing.vanessa_config`: владельца, `runtime_profile`,
`features`, `results`, `server_name`. Каталог feature-файлов должен находиться
внутри репозитория владельца. Внешнее окружение 1С/Vanessa предоставляется отдельно.

`testing.commands` содержит аргументы команды, владельца и объявленные эффекты.
Имя программы — переносимое имя исполняемого файла, без shell-выражения и пути.
Наличие команды в профиле само по себе не разрешает её запуск.

Раздел `knowledge` задаёт провайдер, относительный путь к manifest и выбранные
`collections`. `provider: none` явно отключает знания и сетевые обращения к
OpenViking. Для `provider: openviking` нужен непустой список выбранных коллекций;
весь рекомендуемый набор не требуется. Настроенный транспорт и успешная общая
MCP-проба ещё не подтверждают готовность поиска в этих коллекциях.
Рабочий поисковый адаптер описан как целевой контракт в [INTEGRATIONS.md](INTEGRATIONS.md).
Для OpenViking явно задайте `required` и `dependent_actions` (фазы `discovery`,
`design`, `implementation`, `review`, `runtime`). При `required: true` непустой
список определяет действия, заблокированные до подтверждения поиска.
`required: false` позволяет независимую работу без заявления покрытия знаний.
Эта проверка дополняет общую action policy и не даёт разрешений на действия.
`knowledge.mode` явно выбирает `disabled`, `transitional` или `kora`.
Для включённого провайдера режим обязателен; в режиме `kora` обязательно
`required: true`. Отсутствующий URL, выключенный транспорт или отказ сервера
сохраняют требования профиля. Автоматического перехода к `none` или ослабления
обязательности нет.
В `kora` перечисляются все пять фаз, и gate распространяется на весь штатный
workflow, в том числе на чтение, неизвестные новые операции, resources и prompts.
Relay проверяет его перед каждым native-вызовом и каждым элементом batch;
защита hook и CLI Vanessa сохраняют то же ограничение. Диагностика и настройка
для восстановления доступны. `knowledge.koraReady` остаётся `false`, пока нет
подтверждённого безопасного поиска: переходный режим и общий setup не являются
приёмкой KORA. Активация hook в реальном Codex проверяется отдельно.
Согласованные профили: `none` + `disabled` + пустые коллекции/зависимости +
`required: false`; либо `openviking` + `transitional`/`kora` с выбранными
коллекциями. При `required: false` зависимости пусты, при `true` — непусты.
Для совместимости прежний `provider: none` без новых полей остаётся явным
отключением; активный провайдер требует все поля явно. Схема отклоняет
противоречивый профиль. Включённый транспорт при `provider: none` даёт `invalid`
в диагностике и блокирует workflow без обращения к OpenViking. Выключенный
транспорт или пустой URL при активном провайдере дают `not_configured`, сохраняя
все требования. Сохранённый URL при выключенном транспорте `none` допустим.
Наблюдение и проверка не переписывают настройки для устранения противоречий.
Рекомендации в `knowledge/recommended-manifest.yaml` не расширяют выбранный
scope. `knowledge.coverageScope` в диагностике относится только к выбранным
коллекциям; `apiExistence: not_determined` означает, что состояние подключения
и покрытие сами по себе ничего не доказывают об отсутствии API.
Для MCP ИБ отдельные поля профиля пока не определены; произвольный `connections.database`
текущая схема не принимает.

## CLI для ручной работы

Команды выполняются из корня исходников или установленного плагина;
`PROJECT_DIR`, `PLUGIN_SETTINGS`, `PROFILE_FILE` — заменяемые пути.

```sh
node scripts/profile.mjs init "PROJECT_DIR"
node scripts/profile.mjs validate "PROJECT_DIR/.ai/project.yaml"
node scripts/profile.mjs effective "PROJECT_DIR" --settings "PLUGIN_SETTINGS"
node scripts/profile.mjs export "PROJECT_DIR" --output "PROFILE_FILE"
node scripts/profile.mjs import "PROJECT_DIR" --input "PROFILE_FILE" --replace
```

В CLI `validate` проверяет схему и семантику, но не готовность MCP и не фактические
пути относительно корня. Проверка containment выполняется при загрузке/import/effective.
`--merge` объединяет профиль того же `profile_id`; массивы заменяются.
Импорт поверх существующего профиля требует `--merge` либо `--replace` и создаёт backup.

Локальное назначение EDT для отдельного экземпляра:

```sh
node scripts/profile.mjs configure-instance "PROJECT_DIR" --instance dev --settings "PLUGIN_SETTINGS" --edt-url "EDT_MCP_URL"
```

Это записывает override в пользовательское состояние и не меняет переносимый
профиль. CLI без `--settings` использует `EDT_AI_SETTINGS`, затем
`settings/local.yaml` в корне плагина; MCP-серверы по умолчанию используют
`<state>/settings.json`. Для одинакового результата указывайте один файл явно.
