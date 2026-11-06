# Поля YAML-профиля проекта

Справочник переносимого `.ai/project.yaml` по [схеме версии 0.2](../schemas/project-profile.schema.json).
О создании профиля, примерах и слоях настроек см. [Профили проектов](PROFILES.md).
Для поиска используйте полное имя поля, например `testing.yaxunit_config.runner`.
`[]` обозначает элемент массива. **Да** в колонке «Обязательно» означает, что
поле обязательно внутри родительского объекта, если тот присутствует; условные
требования указаны отдельно. Неизвестные поля отклоняются.

Поля доступны на вкладке «Конфигурация» → «Поля», кроме
`repositories[].edt_required`, который редактируется только в режиме «YAML».
Выберите «Общий · Git»
для `.ai/project.yaml` или «Локальный» для `.ai/project.local.yaml`.
Поиск принимает ключ из первой колонки, например `testing.yaxunit_config.runner`.
Отсутствующий необязательный объект или параметр добавляется кнопкой «+ Добавить»;
элементы массивов и ключи словарей также редактируются в форме.
У каждого поля показаны понятное название и полный ключ YAML.
Идентификация, репозитории и корни, назначенные инструменты, подключения MCP
и управляемые компоненты представлены отдельными группами. Область, поиск
и режим находятся в общей шапке редактора; состояние черновика — рядом
с действиями сохранения. Импорт и экспорт доступны над редактором.

«Поля» и «YAML» используют один черновик выбранного файла. Перед сохранением
выполняется проверка схемы и связанных ограничений, затем показываются изменения.
Переключение файла с несохранёнными изменениями предлагает сохранить, отменить
или продолжить редактирование. Исходная ревизия защищает от перезаписи внешних
изменений. Неизвестные поля и комментарии сохраняются в черновике; проверка
неизвестных полей по действующей схеме остаётся обязательной.

Под полем показаны сохранённое действующее значение и его источник: общий или
локальный профиль, настройки пользователя, файл подключений либо переменная
окружения. Эти сведения вычисляет backend тем же механизмом, что и подключения.
Они не являются результатом применения черновика. Внешние переопределения
перечислены также над формой; редактирование нижнего слоя не меняет их приоритет.
Удаление поля в локальном документе возвращает наследование после сохранения.

Компактные окна на вкладке «Компоненты» оставляют быстрый доступ к подключениям,
включению сервисов, Java, версиям, индексу и тестированию. Имя проекта можно
изменить кнопкой редактирования строки в выпадающем списке профилей в шапке.
В локальной области компактных карточек «Сбросить» готовит удаление
переопределений открытого компонента, включая его включение. Нажмите
«Сохранить», чтобы backend заново вычислил наследование. До сохранения
общий и локальный файлы не изменяются. Отмена черновика компонента
сохраняет несвязанные правки подключений и документа YAML.

## Разделы справочника

| Что нужно найти | Раздел |
| --- | --- |
| ID, версия, назначение проекта | [Идентификация](#identification) |
| Репозитории, EDT-проекты, защищённые пути | [Репозитории и корни](#repositories) |
| Назначенные инструменты | [Инструменты](#authorities) |
| Политика и исключения | [Политика](#policy) |
| Команды, YaXUnit и Vanessa | [Тестирование](#testing) |
| OpenViking, коллекции, поиск | [База знаний](#knowledge) |
| Требование к версии ядра | [Совместимость](#compatibility) |
| Адреса MCP, транспорт, заголовки | [Подключения](#connections) |
| code-index, BSL LS, Java | [Компоненты](#components) |
| Переопределения и валидация | [Слои и проверка](#layers) |

<a id="identification"></a>
## Идентификация

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `schema_version` | Да | Версия схемы: строка `'0.2'`. | Конфигурация → Поля → `schema_version` |
| `profile_id` | Да | ID профиля: до 64 строчных латинских букв, цифр и дефисов; начинается с буквы или цифры. | Конфигурация → Поля → `profile_id` |
| `profile_version` | Да | Версия профиля в формате `major.minor.patch`. | Конфигурация → Поля → `profile_version` |
| `project` | Да | Описание проекта. | Конфигурация → Поля → `project` |
| `project.id` | Да | ID проекта; локальное значение имеет приоритет над общим. | Список профилей → локальное имя; общее значение: Конфигурация → Общий · Git → `project.id` |
| `project.purpose` | Да | Непустое описание назначения проекта. | Конфигурация → Поля → `project.purpose` |
| `project.adapter` | Нет | Описательная метка; не загружает исполняемый адаптер. | Конфигурация → Поля → `project.adapter` |

<a id="repositories"></a>
## Репозитории и корни

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `repositories` | Да | Массив репозиториев; может быть пустым. | Конфигурация → Поля → `repositories` |
| `repositories[].id` | Да | Уникальный ID репозитория для ссылок из других разделов. | Конфигурация → Поля → `repositories[].id` |
| `repositories[].path` | Да | Относительный путь от корня проекта к репозиторию. | Конфигурация → Поля → `repositories[].path` |
| `repositories[].alias` | Да | Уникальный alias для code-index. | Конфигурация → Поля → `repositories[].alias` |
| `repositories[].edt_project` | Нет | Точное имя проекта EDT или `null`. | Конфигурация → Поля → `repositories[].edt_project` |
| `repositories[].edt_required` | Нет | Boolean; отсутствие означает `true`. При `false` подтверждённо закрытый назначенный проект допустим для основной работы; открытый должен быть готов. | Только Конфигурация → YAML, общий или локальный файл |
| `roots` | Да | Корни исходников и защиты. | Конфигурация → Поля → `roots` |
| `roots.source` | Да | Массив относительных путей к исходникам. | Конфигурация → Поля → `roots.source` |
| `roots.protected` | Да | Массив дополнительно защищённых относительных путей. | Конфигурация → Поля → `roots.protected` |

Для ID проекта и репозиториев используются латинские буквы, цифры, `.`, `_`,
`-`; первый символ — буква или цифра, длина до 64 символов. Alias начинается
с буквы или цифры и содержит те же символы. Пути не должны быть абсолютными,
содержать `..` или выходить за корень проекта, в том числе через symlink или
junction. Guard защищает объединение `roots.source` и `roots.protected`.
Несколько обязательных EDT-проектов допустимы; без готового обязательного
назначения EDT не получает `ready`. Необязательность не отменяет проверку
точного имени, пути и локального дескриптора или требования тестовых зависимостей.
См. [правила готовности EDT](PROFILES.md#обязательные-и-необязательные-edt-проекты).

<a id="authorities"></a>
## Назначенные инструменты: `authorities`

Раздел и все четыре поля обязательны; значения фиксированы.

| Поле | Значение | Назначение | Путь в настройках |
| --- | --- | --- | --- |
| `authorities` | Объект | Назначенные инструменты; раздел обязателен. | Конфигурация → Поля → `authorities` |
| `authorities.edt_writer` | `edt` | Изменение исходников и метаданных. | Конфигурация → Поля → `authorities.edt_writer` |
| `authorities.code_index` | `code-index` | Поиск и анализ исходников. | Конфигурация → Поля → `authorities.code_index` |
| `authorities.bsl_ls` | `bsl-ls` | Дополнительная диагностика и навигация BSL. | Конфигурация → Поля → `authorities.bsl_ls` |
| `authorities.v8std` | `v8std` | Нормы и стандарты. | Конфигурация → Поля → `authorities.v8std` |

<a id="policy"></a>
## Политика: `policy`

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `policy` | Да | Настройки политики проекта. | Конфигурация → Поля → `policy` |
| `policy.mode` | Да | Режим; только `conservative`. | Конфигурация → Поля → `policy.mode` |
| `policy.allow_shell_source_read` | Нет | Чтение защищённых исходников через shell; только `false`. | Конфигурация → Поля → `policy.allow_shell_source_read` |
| `policy.require_explicit_confirmation` | Нет | Массив категорий: `cleanup`, `launch`, `database`, `remote_git`. | Конфигурация → Поля → `policy.require_explicit_confirmation` |
| `policy.edt_repository_ids` | Нет | ID репозиториев, назначенных для EDT. | Конфигурация → Поля → `policy.edt_repository_ids` |
| `policy.unbound_edt_repositories` | Нет | ID репозиториев, явно оставленных без привязки к EDT. | Конфигурация → Поля → `policy.unbound_edt_repositories` |
| `policy.exceptions` | Нет | Массив проектных исключений из норм. | Конфигурация → Поля → `policy.exceptions` |
| `policy.exceptions[].id` | Да | ID исключения. | Конфигурация → Поля → `policy.exceptions[].id` |
| `policy.exceptions[].selectors` | Да | Непустой массив селекторов норм. | Конфигурация → Поля → `policy.exceptions[].selectors` |
| `policy.exceptions[].repository_ids` | Да | Массив ID репозиториев, к которым относится исключение. | Конфигурация → Поля → `policy.exceptions[].repository_ids` |
| `policy.exceptions[].reason` | Да | Непустая причина исключения. | Конфигурация → Поля → `policy.exceptions[].reason` |
| `policy.exceptions[].source` | Да | Непустое основание или источник исключения. | Конфигурация → Поля → `policy.exceptions[].source` |

Списки EDT-репозиториев ссылаются на известные ID и не пересекаются.
Для исключений нужны уникальные ID и непустой список известных репозиториев.
Исключения не отменяют общую action policy или защиту исходников.

<a id="testing"></a>
## Тестирование: `testing`

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `testing` | Да | Настройки тестирования. | Конфигурация → Поля → `testing` |
| `testing.yaxunit` | Да | Включение YaXUnit: `true` или `false`. | Конфигурация → Поля → `testing.yaxunit` |
| `testing.vanessa` | Да | Включение Vanessa: `true` или `false`. | Конфигурация → Поля → `testing.vanessa` |

### Команды

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `testing.commands` | Да | Массив зарегистрированных команд; может быть пустым. | Конфигурация → Поля → `testing.commands` |
| `testing.commands[].id` | Да | ID команды. | Конфигурация → Поля → `testing.commands[].id` |
| `testing.commands[].repository_id` | Да | ID репозитория команды. | Конфигурация → Поля → `testing.commands[].repository_id` |
| `testing.commands[].argv` | Да | Непустой массив программы и аргументов. | Конфигурация → Поля → `testing.commands[].argv` |
| `testing.commands[].effects` | Да | Массив эффектов: `cleanup`, `launch`, `database`, `remote_git`; может быть пустым. | Конфигурация → Поля → `testing.commands[].effects` |
| `testing.commands[].timeout_seconds` | Нет | Целый тайм-аут в секундах, от 1 до 3600. | Конфигурация → Поля → `testing.commands[].timeout_seconds` |

### YaXUnit

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `testing.yaxunit_config` | Условно | Обязателен при `testing.yaxunit: true`. | Конфигурация → Поля → `testing.yaxunit_config` |
| `testing.yaxunit_config.repository_id` | Да | ID репозитория тестов. | Конфигурация → Поля → `testing.yaxunit_config.repository_id` |
| `testing.yaxunit_config.framework_repository_id` | Нет | ID репозитория фреймворка. | Конфигурация → Поля → `testing.yaxunit_config.framework_repository_id` |
| `testing.yaxunit_config.product_repository_ids` | Нет | Массив ID репозиториев продукта. | Конфигурация → Поля → `testing.yaxunit_config.product_repository_ids` |
| `testing.yaxunit_config.runner` | Да | Способ запуска; только `edt`. | Конфигурация → Поля → `testing.yaxunit_config.runner` |
| `testing.yaxunit_config.results` | Да | Относительный путь к результатам. | Конфигурация → Поля → `testing.yaxunit_config.results` |
| `testing.yaxunit_config.launch_configuration` | Нет | Точное имя клиентской конфигурации запуска EDT. Поле предлагает имена, обнаруженные проверкой YaXUnit; без имени проверяется однозначный запуск через проект и приложение EDT. | Конфигурация → Поля → `testing.yaxunit_config.launch_configuration` |

### Vanessa

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `testing.vanessa_config` | Условно | Обязателен при `testing.vanessa: true`. | Конфигурация → Поля → `testing.vanessa_config` |
| `testing.vanessa_config.repository_id` | Да | ID репозитория тестов. | Конфигурация → Поля → `testing.vanessa_config.repository_id` |
| `testing.vanessa_config.runtime_profile` | Да | Относительный путь к runtime-профилю Vanessa. | Конфигурация → Поля → `testing.vanessa_config.runtime_profile` |
| `testing.vanessa_config.features` | Да | Относительный путь к feature-сценариям. | Конфигурация → Поля → `testing.vanessa_config.features` |
| `testing.vanessa_config.results` | Да | Относительный путь к результатам. | Конфигурация → Поля → `testing.vanessa_config.results` |
| `testing.vanessa_config.server_name` | Да | Имя сервера: латинские буквы, цифры, `_` и `-`. | Конфигурация → Поля → `testing.vanessa_config.server_name` |

ID команд уникальны, их репозитории должны существовать. Первый элемент `argv`
задаёт переносимое имя исполняемого файла, а не путь или shell-выражение.
Репозитории конфигураций тестов должны существовать. Репозитории фреймворка
и тестов YaXUnit должны различаться; включённому YaXUnit нужен назначенный
проект EDT для репозитория тестов. Каталог feature-сценариев Vanessa должен
находиться внутри её репозитория.

<a id="knowledge"></a>
## База знаний: `knowledge`

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `knowledge` | Да | Настройки базы знаний. | Конфигурация → Поля → `knowledge` |
| `knowledge.provider` | Да | `none` или `openviking`. | Конфигурация → Поля → `knowledge.provider` |
| `knowledge.manifest` | Да | Относительный путь к manifest или `null`. | Конфигурация → Поля → `knowledge.manifest` |
| `knowledge.mode` | Да | `disabled`, `transitional` или `kora`. | Конфигурация → Поля → `knowledge.mode` |
| `knowledge.required` | Да | `true` / `false`. | Конфигурация → Поля → `knowledge.required` |
| `knowledge.dependent_actions` | Да | Массив этапов: `discovery`, `design`, `implementation`, `review`, `runtime`. | Конфигурация → Поля → `knowledge.dependent_actions` |
| `knowledge.collections` | Да | Массив ID коллекций. | Конфигурация → Поля → `knowledge.collections` |
| `knowledge.collection_uris` | Нет | Карта ID коллекции на URI вида `viking://resources/...`. | Конфигурация → Поля → `knowledge.collection_uris` |

### Ограничения поиска

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `knowledge.search` | Нет | Требования и ограничения поиска. | Конфигурация → Поля → `knowledge.search` |
| `knowledge.search.publication` | Да | Только `verified`. | Конфигурация → Поля → `knowledge.search.publication` |
| `knowledge.search.snapshot` | Да | Только `consistent`. | Конфигурация → Поля → `knowledge.search.snapshot` |
| `knowledge.search.access` | Да | Только `read_only`. | Конфигурация → Поля → `knowledge.search.access` |
| `knowledge.search.max_results` | Да | Максимум результатов: целое число 1–100. | Конфигурация → Поля → `knowledge.search.max_results` |
| `knowledge.search.max_excerpt_chars` | Да | Максимум символов отрывка: целое число 128–8000. | Конфигурация → Поля → `knowledge.search.max_excerpt_chars` |
| `knowledge.search.max_material_chars` | Да | Максимум символов материала: целое число 1024–100000. | Конфигурация → Поля → `knowledge.search.max_material_chars` |

- При `provider: none` требуется `manifest: null`; поля `mode` и `required`
  равны `disabled` и `false`. Массивы коллекций и зависимых действий
  и карта URI должны быть пустыми; `search` запрещён.
- При `provider: openviking` обязательны `mode`, `collections`, `required` и
  `dependent_actions`; режим — `transitional` или `kora`, коллекция нужна хотя бы одна.
- При `required: true` нужен непустой `dependent_actions`; при `false` он пуст.
  `mode: kora` требует `required: true` и все пять этапов.

<a id="compatibility"></a>
## Совместимость: `compatibility`

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `compatibility` | Да | Требования совместимости. | Конфигурация → Поля → `compatibility` |
| `compatibility.core` | Да | Требование к версии запущенного ядра, например `'>=0.1.0'`; числовые SemVer-сравнения разделяются пробелами, альтернативы — `\|\|`. | Конфигурация → Поля → `compatibility.core` |

<a id="connections"></a>
## Подключения: `connections`

`connections` и каждый из объектов `connections.edt`, `connections.v8std`,
`connections.openviking` необязательны. Для каждого объекта доступны следующие необязательные поля.

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `connections` | Необязательный раздел. | Конфигурация → Поля → `connections` |

### `connections.edt`

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `connections.edt` | Необязательный объект. | Конфигурация → Поля → `connections.edt` |
| `connections.edt.enabled` | Включено ли подключение: `true` / `false`. | Конфигурация → Поля → `connections.edt.enabled` |
| `connections.edt.url` | HTTP(S)-адрес либо пустая строка. | Конфигурация → Поля → `connections.edt.url` |
| `connections.edt.url_env` | Имя переменной окружения с адресом. | Конфигурация → Поля → `connections.edt.url_env` |
| `connections.edt.timeout_seconds` | Положительный тайм-аут в секундах. | Конфигурация → Поля → `connections.edt.timeout_seconds` |
| `connections.edt.max_response_bytes` | Целый предел ответа от 1024 байт. | Конфигурация → Поля → `connections.edt.max_response_bytes` |
| `connections.edt.headers_env` | Карта имени HTTP-заголовка на имя переменной окружения с полным значением. | Конфигурация → Поля → `connections.edt.headers_env` |

### `connections.v8std`

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `connections.v8std` | Необязательный объект. | Конфигурация → Поля → `connections.v8std` |
| `connections.v8std.enabled` | Включено ли подключение: `true` / `false`. | Конфигурация → Поля → `connections.v8std.enabled` |
| `connections.v8std.url` | HTTP(S)-адрес либо пустая строка. | Конфигурация → Поля → `connections.v8std.url` |
| `connections.v8std.url_env` | Имя переменной окружения с адресом. | Конфигурация → Поля → `connections.v8std.url_env` |
| `connections.v8std.timeout_seconds` | Положительный тайм-аут в секундах. | Конфигурация → Поля → `connections.v8std.timeout_seconds` |
| `connections.v8std.max_response_bytes` | Целый предел ответа от 1024 байт. | Конфигурация → Поля → `connections.v8std.max_response_bytes` |
| `connections.v8std.headers_env` | Карта имени HTTP-заголовка на имя переменной окружения с полным значением. | Конфигурация → Поля → `connections.v8std.headers_env` |

### `connections.openviking`

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `connections.openviking` | Необязательный объект. | Конфигурация → Поля → `connections.openviking` |
| `connections.openviking.enabled` | Включено ли подключение: `true` / `false`. | Конфигурация → Поля → `connections.openviking.enabled` |
| `connections.openviking.url` | HTTP(S)-адрес либо пустая строка. | Конфигурация → Поля → `connections.openviking.url` |
| `connections.openviking.timeout_seconds` | Положительный тайм-аут в секундах, максимум 300. | Конфигурация → Поля → `connections.openviking.timeout_seconds` |
| `connections.openviking.max_response_bytes` | Целый предел ответа от 1024 до 16777216 байт. | Конфигурация → Поля → `connections.openviking.max_response_bytes` |
| `connections.openviking.connection_id` | Необязательный код: 1–64 ASCII-буквы, цифры, точки, дефисы или подчёркивания; первый символ — буква или цифра. Пустая строка означает отсутствие кода. | Конфигурация → Поля → `connections.openviking.connection_id` |

Не записывайте секреты в YAML или URL. Адреса и параметры окружения удобнее
держать в локальном overlay; см. [подключения и экземпляры](PROFILES.md#подключения-и-экземпляры).

<a id="components"></a>
## Компоненты: `components`

`components`, `components.code-index` и `components.bsl-ls` необязательны.
Поля обоих объектов необязательны.

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `components` | Необязательный раздел. | Конфигурация → Поля → `components` |

### `components.code-index`

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `components.code-index` | Необязательный объект. | Конфигурация → Поля → `components.code-index` |
| `components.code-index.mode` | `auto` или `external`. | Конфигурация → Поля → `components.code-index.mode` |
| `components.code-index.version` | Версия компонента или `latest`. | Конфигурация → Поля → `components.code-index.version` |
| `components.code-index.enabled` | Включён ли компонент: `true` / `false`. | Конфигурация → Поля → `components.code-index.enabled` |
| `components.code-index.url` | HTTP(S)-адрес внешнего компонента либо пустая строка. | Конфигурация → Поля → `components.code-index.url` |
| `components.code-index.timeout_seconds` | Положительный тайм-аут в секундах. | Конфигурация → Поля → `components.code-index.timeout_seconds` |
| `components.code-index.max_response_bytes` | Целый предел ответа от 1024 байт. | Конфигурация → Поля → `components.code-index.max_response_bytes` |
| `components.code-index.headers_env` | Карта HTTP-заголовков на имена переменных окружения. | Конфигурация → Поля → `components.code-index.headers_env` |
| `components.code-index.allow_prerelease` | Разрешать ли предварительные версии. | Конфигурация → Поля → `components.code-index.allow_prerelease` |

### `components.bsl-ls`

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `components.bsl-ls` | Необязательный объект. | Конфигурация → Поля → `components.bsl-ls` |
| `components.bsl-ls.mode` | `auto` или `external`. | Конфигурация → Поля → `components.bsl-ls.mode` |
| `components.bsl-ls.version` | Для managed JAR: версия не ниже 1.1.0-rc.4 или `latest`; по умолчанию выбирается подходящий стабильный выпуск, а при его отсутствии — последний RC 1.1.0. С `allow_prerelease: true` также учитываются другие подходящие предварительные выпуски. | Конфигурация → Поля → `components.bsl-ls.version` |
| `components.bsl-ls.enabled` | Включён ли компонент: `true` / `false`. | Конфигурация → Поля → `components.bsl-ls.enabled` |
| `components.bsl-ls.url` | HTTP(S)-адрес внешнего компонента либо пустая строка. | Конфигурация → Поля → `components.bsl-ls.url` |
| `components.bsl-ls.timeout_seconds` | Положительный тайм-аут в секундах. | Конфигурация → Поля → `components.bsl-ls.timeout_seconds` |
| `components.bsl-ls.max_response_bytes` | Целый предел ответа от 1024 байт. | Конфигурация → Поля → `components.bsl-ls.max_response_bytes` |
| `components.bsl-ls.headers_env` | Карта HTTP-заголовков на имена переменных окружения. | Конфигурация → Поля → `components.bsl-ls.headers_env` |
| `components.bsl-ls.allow_prerelease` | Разрешать ли автоматический выбор подходящих предварительных версий; при `false` RC 1.1.0 используется, если подходящего стабильного релиза нет. | Конфигурация → Поля → `components.bsl-ls.allow_prerelease` |

Дополнительные поля BSL LS:

| Поле | Обязательно | Назначение | Путь в настройках |
| --- | --- | --- | --- |
| `components.bsl-ls.java` | Нет | Путь или команда Java. | Конфигурация → Поля → `components.bsl-ls.java` |
| `components.bsl-ls.node` | Нет | Путь или команда Node.js. | Конфигурация → Поля → `components.bsl-ls.node` |
| `components.bsl-ls.configuration` | Нет | Путь к конфигурации BSL LS или `null`. | Конфигурация → Поля → `components.bsl-ls.configuration` |

<a id="layers"></a>
## Слои и проверка

`.ai/project.local.yaml` может задавать частичные
переопределения. Объекты объединяются по полям, массивы и скаляры заменяются;
явная карта `headers_env` подключения заменяет унаследованную целиком. Частичные
слои проверяются по [локальной схеме](../schemas/project-local.schema.json),
объединённый профиль — по полной схеме и дополнительным правилам
[profile.mjs](../scripts/profile.mjs). Локальные значения не могут ослабить
общую защиту исходников. Подробности и команды проверки — в
[документации профилей](PROFILES.md).
