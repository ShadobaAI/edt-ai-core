# Поля YAML-профиля проекта

Справочник переносимого `.ai/project.yaml` по [схеме версии 0.2](../schemas/project-profile.schema.json).
О создании профиля, примерах и слоях настроек см. [Профили проектов](PROFILES.md).
Для поиска используйте полное имя поля, например `testing.yaxunit_config.runner`.
`[]` обозначает элемент массива. **Да** в колонке «Обязательно» означает, что
поле обязательно внутри родительского объекта, если тот присутствует; условные
требования указаны отдельно. Неизвестные поля отклоняются.

В колонке «Путь в настройках» указаны отдельные элементы формы настроек плагина.
«—» означает, что отдельного элемента для поля нет. Общий редактор находится
на вкладке «Профиль и среда» → «Изменять в» → «Профиль проекта»; изменения
должны соответствовать схеме. Для изменения именно общего
профиля в формах подключений выберите «Изменять в» → «Профиль проекта»,
а в формах компонентов — «Изменять в» → «Общий профиль проекта».
Доступность изменения зависит от выбранного профиля и приоритетов настроек.

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
| `schema_version` | Да | Версия схемы: строка `'0.2'`. | — |
| `profile_id` | Да | ID профиля: до 64 строчных латинских букв, цифр и дефисов; начинается с буквы или цифры. | — |
| `profile_version` | Да | Версия профиля в формате `major.minor.patch`. | — |
| `project` | Да | Описание проекта. | — |
| `project.id` | Да | ID проекта. | Заголовок профиля → «Переименовать профиль» → «Имя проекта» |
| `project.purpose` | Да | Непустое описание назначения проекта. | — |
| `project.adapter` | Нет | Описательная метка; не загружает исполняемый адаптер. | — |

<a id="repositories"></a>
## Репозитории и корни

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `repositories` | Да | Массив репозиториев; может быть пустым. | — |
| `repositories[].id` | Да | Уникальный ID репозитория для ссылок из других разделов. | — |
| `repositories[].path` | Да | Относительный путь от корня проекта к репозиторию. | — |
| `repositories[].alias` | Да | Уникальный alias для code-index. | — |
| `repositories[].edt_project` | Нет | Точное имя проекта EDT или `null`. | — |
| `roots` | Да | Корни исходников и защиты. | — |
| `roots.source` | Да | Массив относительных путей к исходникам. | — |
| `roots.protected` | Да | Массив дополнительно защищённых относительных путей. | — |

Для ID проекта и репозиториев используются латинские буквы, цифры, `.`, `_`,
`-`; первый символ — буква или цифра, длина до 64 символов. Alias начинается
с буквы или цифры и содержит те же символы. Пути не должны быть абсолютными,
содержать `..` или выходить за корень проекта, в том числе через symlink или
junction. Guard защищает объединение `roots.source` и `roots.protected`.

<a id="authorities"></a>
## Назначенные инструменты: `authorities`

Раздел и все четыре поля обязательны; значения фиксированы.

| Поле | Значение | Назначение | Путь в настройках |
| --- | --- | --- | --- |
| `authorities` | Объект | Назначенные инструменты; раздел обязателен. | — |
| `authorities.edt_writer` | `edt` | Изменение исходников и метаданных. | — |
| `authorities.code_index` | `code-index` | Поиск и анализ исходников. | — |
| `authorities.bsl_ls` | `bsl-ls` | Дополнительная диагностика и навигация BSL. | — |
| `authorities.v8std` | `v8std` | Нормы и стандарты. | — |

<a id="policy"></a>
## Политика: `policy`

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `policy` | Да | Настройки политики проекта. | — |
| `policy.mode` | Да | Режим; только `conservative`. | — |
| `policy.allow_shell_source_read` | Нет | Чтение защищённых исходников через shell; только `false`. | — |
| `policy.require_explicit_confirmation` | Нет | Массив категорий: `cleanup`, `launch`, `database`, `remote_git`. | — |
| `policy.edt_repository_ids` | Нет | ID репозиториев, назначенных для EDT. | — |
| `policy.unbound_edt_repositories` | Нет | ID репозиториев, явно оставленных без привязки к EDT. | — |
| `policy.exceptions` | Нет | Массив проектных исключений из норм. | — |
| `policy.exceptions[].id` | Да | ID исключения. | — |
| `policy.exceptions[].selectors` | Да | Непустой массив селекторов норм. | — |
| `policy.exceptions[].repository_ids` | Да | Массив ID репозиториев, к которым относится исключение. | — |
| `policy.exceptions[].reason` | Да | Непустая причина исключения. | — |
| `policy.exceptions[].source` | Да | Непустое основание или источник исключения. | — |

Списки EDT-репозиториев ссылаются на известные ID и не пересекаются.
Для исключений нужны уникальные ID и непустой список известных репозиториев.
Исключения не отменяют общую action policy или защиту исходников.

<a id="testing"></a>
## Тестирование: `testing`

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `testing` | Да | Настройки тестирования. | — |
| `testing.yaxunit` | Да | Включение YaXUnit: `true` или `false`. | — |
| `testing.vanessa` | Да | Включение Vanessa: `true` или `false`. | — |

### Команды

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `testing.commands` | Да | Массив зарегистрированных команд; может быть пустым. | — |
| `testing.commands[].id` | Да | ID команды. | — |
| `testing.commands[].repository_id` | Да | ID репозитория команды. | — |
| `testing.commands[].argv` | Да | Непустой массив программы и аргументов. | — |
| `testing.commands[].effects` | Да | Массив эффектов: `cleanup`, `launch`, `database`, `remote_git`; может быть пустым. | — |
| `testing.commands[].timeout_seconds` | Нет | Целый тайм-аут в секундах, от 1 до 3600. | — |

### YaXUnit

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `testing.yaxunit_config` | Условно | Обязателен при `testing.yaxunit: true`. | — |
| `testing.yaxunit_config.repository_id` | Да | ID репозитория тестов. | — |
| `testing.yaxunit_config.framework_repository_id` | Нет | ID репозитория фреймворка. | — |
| `testing.yaxunit_config.product_repository_ids` | Нет | Массив ID репозиториев продукта. | — |
| `testing.yaxunit_config.runner` | Да | Способ запуска; только `edt`. | — |
| `testing.yaxunit_config.results` | Да | Относительный путь к результатам. | — |
| `testing.yaxunit_config.launch_configuration` | Нет | Имя конфигурации запуска EDT. | — |

### Vanessa

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `testing.vanessa_config` | Условно | Обязателен при `testing.vanessa: true`. | — |
| `testing.vanessa_config.repository_id` | Да | ID репозитория тестов. | — |
| `testing.vanessa_config.runtime_profile` | Да | Относительный путь к runtime-профилю Vanessa. | — |
| `testing.vanessa_config.features` | Да | Относительный путь к feature-сценариям. | — |
| `testing.vanessa_config.results` | Да | Относительный путь к результатам. | — |
| `testing.vanessa_config.server_name` | Да | Имя сервера: латинские буквы, цифры, `_` и `-`. | — |

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
| `knowledge` | Да | Настройки базы знаний. | — |
| `knowledge.provider` | Да | `none` или `openviking`. | — |
| `knowledge.manifest` | Да | Относительный путь к manifest или `null`. | — |
| `knowledge.mode` | Да | `disabled`, `transitional` или `kora`. | — |
| `knowledge.required` | Да | `true` / `false`. | — |
| `knowledge.dependent_actions` | Да | Массив этапов: `discovery`, `design`, `implementation`, `review`, `runtime`. | — |
| `knowledge.collections` | Да | Массив ID коллекций. | — |
| `knowledge.collection_uris` | Нет | Карта ID коллекции на URI вида `viking://resources/...`. | — |

### Ограничения поиска

| Поле | Обязательно | Назначение и формат | Путь в настройках |
| --- | --- | --- | --- |
| `knowledge.search` | Нет | Требования и ограничения поиска. | — |
| `knowledge.search.publication` | Да | Только `verified`. | — |
| `knowledge.search.snapshot` | Да | Только `consistent`. | — |
| `knowledge.search.access` | Да | Только `read_only`. | — |
| `knowledge.search.max_results` | Да | Максимум результатов: целое число 1–100. | — |
| `knowledge.search.max_excerpt_chars` | Да | Максимум символов отрывка: целое число 128–8000. | — |
| `knowledge.search.max_material_chars` | Да | Максимум символов материала: целое число 1024–100000. | — |

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
| `compatibility` | Да | Требования совместимости. | — |
| `compatibility.core` | Да | Требование к версии запущенного ядра, например `'>=0.1.0'`; числовые SemVer-сравнения разделяются пробелами, альтернативы — `\|\|`. | — |

<a id="connections"></a>
## Подключения: `connections`

`connections` и каждый из объектов `connections.edt`, `connections.v8std`,
`connections.openviking` необязательны. Для каждого объекта доступны следующие необязательные поля.

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `connections` | Необязательный раздел. | — |

### `connections.edt`

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `connections.edt` | Необязательный объект. | — |
| `connections.edt.enabled` | Включено ли подключение: `true` / `false`. | — |
| `connections.edt.url` | HTTP(S)-адрес либо пустая строка. | «Подключения» → «Серверы MCP» → «EDT» |
| `connections.edt.url_env` | Имя переменной окружения с адресом. | — |
| `connections.edt.timeout_seconds` | Положительный тайм-аут в секундах. | — |
| `connections.edt.max_response_bytes` | Целый предел ответа от 1024 байт. | — |
| `connections.edt.headers_env` | Карта имени HTTP-заголовка на имя переменной окружения с полным значением. | — |

### `connections.v8std`

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `connections.v8std` | Необязательный объект. | — |
| `connections.v8std.enabled` | Включено ли подключение: `true` / `false`. | — |
| `connections.v8std.url` | HTTP(S)-адрес либо пустая строка. | «Подключения» → «Серверы MCP» → «v8std» |
| `connections.v8std.url_env` | Имя переменной окружения с адресом. | — |
| `connections.v8std.timeout_seconds` | Положительный тайм-аут в секундах. | — |
| `connections.v8std.max_response_bytes` | Целый предел ответа от 1024 байт. | — |
| `connections.v8std.headers_env` | Карта имени HTTP-заголовка на имя переменной окружения с полным значением. | — |

### `connections.openviking`

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `connections.openviking` | Необязательный объект. | — |
| `connections.openviking.enabled` | Включено ли подключение: `true` / `false`. | «Подключения» → «Серверы MCP» → «Использовать OpenViking» |
| `connections.openviking.url` | HTTP(S)-адрес либо пустая строка. | «Подключения» → «Серверы MCP» → «OpenViking» |
| `connections.openviking.url_env` | Имя переменной окружения с адресом. | — |
| `connections.openviking.timeout_seconds` | Положительный тайм-аут в секундах, максимум 300. | «Подключения» → «Дополнительные настройки OpenViking» → «Таймаут, секунды» |
| `connections.openviking.max_response_bytes` | Целый предел ответа от 1024 до 16777216 байт. | «Подключения» → «Дополнительные настройки OpenViking» → «Лимит ответа, байт» |
| `connections.openviking.headers_env` | Карта имени HTTP-заголовка на имя переменной окружения с полным значением. | «Подключения» → «Дополнительные настройки OpenViking» → «Заголовки → имена переменных окружения» |

Не записывайте секреты в YAML или URL. Адреса и параметры окружения удобнее
держать в локальном overlay; см. [подключения и экземпляры](PROFILES.md#подключения-и-экземпляры).

<a id="components"></a>
## Компоненты: `components`

`components`, `components.code-index` и `components.bsl-ls` необязательны.
Поля обоих объектов необязательны.

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `components` | Необязательный раздел. | — |

### `components.code-index`

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `components.code-index` | Необязательный объект. | — |
| `components.code-index.mode` | `auto` или `external`. | — |
| `components.code-index.version` | Версия компонента или `latest`. | — |
| `components.code-index.enabled` | Включён ли компонент: `true` / `false`. | «Компоненты» → «Компоненты этой папки» → «Индекс кода» |
| `components.code-index.url` | HTTP(S)-адрес внешнего компонента либо пустая строка. | — |
| `components.code-index.timeout_seconds` | Положительный тайм-аут в секундах. | — |
| `components.code-index.max_response_bytes` | Целый предел ответа от 1024 байт. | — |
| `components.code-index.headers_env` | Карта HTTP-заголовков на имена переменных окружения. | — |
| `components.code-index.allow_prerelease` | Разрешать ли предварительные версии. | — |

### `components.bsl-ls`

| Поле | Назначение и формат | Путь в настройках |
| --- | --- | --- |
| `components.bsl-ls` | Необязательный объект. | — |
| `components.bsl-ls.mode` | `auto` или `external`. | — |
| `components.bsl-ls.version` | Для managed JAR: версия не ниже 1.1.0-rc.4 или `latest`; по умолчанию выбирается подходящий стабильный выпуск, а при его отсутствии — последний RC 1.1.0. С `allow_prerelease: true` также учитываются другие подходящие предварительные выпуски. | — |
| `components.bsl-ls.enabled` | Включён ли компонент: `true` / `false`. | «Компоненты» → «Компоненты этой папки» → «BSL LS» |
| `components.bsl-ls.url` | HTTP(S)-адрес внешнего компонента либо пустая строка. | — |
| `components.bsl-ls.timeout_seconds` | Положительный тайм-аут в секундах. | — |
| `components.bsl-ls.max_response_bytes` | Целый предел ответа от 1024 байт. | — |
| `components.bsl-ls.headers_env` | Карта HTTP-заголовков на имена переменных окружения. | — |
| `components.bsl-ls.allow_prerelease` | Разрешать ли автоматический выбор подходящих предварительных версий; при `false` RC 1.1.0 используется, если подходящего стабильного релиза нет. | — |

Дополнительные поля BSL LS:

| Поле | Обязательно | Назначение | Путь в настройках |
| --- | --- | --- | --- |
| `components.bsl-ls.java` | Нет | Путь или команда Java. | «Компоненты» → «Java для BSL LS» → «Исполняемый файл» |
| `components.bsl-ls.node` | Нет | Путь или команда Node.js. | — |
| `components.bsl-ls.configuration` | Нет | Путь к конфигурации BSL LS или `null`. | — |

<a id="layers"></a>
## Слои и проверка

`.ai/project.local.yaml` и overrides экземпляра могут задавать частичные
переопределения. Объекты объединяются по полям, массивы и скаляры заменяются;
явная карта `headers_env` подключения заменяет унаследованную целиком. Частичные
слои проверяются по [локальной схеме](../schemas/project-local.schema.json),
объединённый профиль — по полной схеме и дополнительным правилам
[profile.mjs](../scripts/profile.mjs). Локальные значения не могут ослабить
общую защиту исходников. Подробности и команды проверки — в
[документации профилей](PROFILES.md).
