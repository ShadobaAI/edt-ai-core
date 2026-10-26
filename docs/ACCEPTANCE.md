# Локальная приёмка текущего этапа

Проверки ниже воспроизводятся из dev-checkout на изолированных фикстурах.
Они не подтверждают качество внешнего корпуса или live-приёмку установленного
плагина, EDT, v8std, JAR и хоста Codex. Раздел 2 плана остаётся отдельной работой.

| Область | Воспроизводимая проверка |
| --- | --- |
| Провайдер включён/отключён, выбранная часть коллекций | `tests/test-knowledge.mjs`: mode/provider/transport matrix, отсутствие сети при disabled; `tests/test-openviking.mjs`: выбранные коллекции и независимые профили на одном сервере |
| Overrides и параллельные сессии | `tests/test-knowledge-settings.mjs`: все уровни precedence, замена/очистка credential mappings, instance isolation; `tests/test-openviking.mjs`: разные directory/instance/session, отключение одного клиента сохраняет другой |
| Неподтверждённый индекс и несовместимые материалы | `tests/test-knowledge.mjs`: setup readiness не открывает workflow; `tests/test-openviking.mjs`: saved connection/publication не доказывают search readiness, несовместимые contracts/metadata отвергаются |
| Доступ, scope и инструкции в контенте | `tests/test-openviking.mjs`: signed access обязателен до сети, foreign collections/URI и mutation запрещены; опубликованные инструкции возвращаются как недоверенные данные без изменения профиля/полномочий |
| Статусы, смена публикации, partial и старый binding | `tests/test-openviking.mjs`: API statuses/review pointers/obsolete filtering, publication rotation/expiry during read, incomplete search, late connection/status/retrieval и roots-change responses |
| Без внешних баз и `provider: none` | `tests/test-setup.mjs`, `tests/test-production-regressions.mjs`, `tests/test-node-only-runtime.mjs` и disabled-cases knowledge: startup/status/фикстурные native workflows без сервера знаний; отсутствие сети проверяется отдельно |

Команда: `node --test tests/test-knowledge.mjs tests/test-knowledge-settings.mjs tests/test-openviking.mjs`.
Регрессии добавлены вместе с соответствующими изменениями; дублировать их
ради отдельного этапа приёмки не требуется.

Поведенческие задачи, скрытые от исполнителя эталоны и сохранённые ответы:
`tests/behavioral/` только в dev-checkout, не в ZIP. Проверяются выбор механизма,
достаточность, L/M/H по последствиям и остановка поиска/декомпозиции. Это отдельный
качественный smoke-прогон инструкций, а не автоматическая или live-приёмка.
Отдельные задачи покрывают похожий, но неприменимый API, обоснованный новый код,
гарантию типа и недоверенный ввод. Известный подходящий API проверяется без
повторного поиска. Исходные пропуск ревью M и ошибочная классификация новой
операции как L, исправления навыка и успешные повторы сохранены в evidence.
Задачи `mandatory-wrapper` и `dirty-contract` проверяют обязательный проектный
маршрут и адресное обновление evidence при незакоммичённой смене контракта.

Согласованность поставки проверяет `tests/test-packaging.mjs`: каждый вход
package allowlist сравнивается с извлечённой копией, включая skills, policy,
hooks, схемы и MCP; версия сгенерированного manifest проверяется отдельно.
`tools/check-plugin.mjs` запускает именно извлечённые MCP с bundled dependencies
и проверяет контракты без внешних серверов. Это локальная модель установленной
поставки, без изменения пользовательского plugin cache и без подтверждения
активации hooks настоящим хостом.

Source guard учитывается тремя разными результатами: регистрация PreToolUse
в manifest/hooks, прямой запуск извлечённого `hooks/guard.mjs` с запрещённой
fixture-записью (deny), фактическая активация хостом (`not_verified`). Первые
два проверяются локально; третий требует отдельной live-приёмки. Дополнительные
попытки shell/read/write/patch/traversal проверяет `tests/test-profiles.mjs`.

Версии и отказ несовместимых данных описаны в [PROFILES.md](PROFILES.md).
`tests/test-knowledge-contracts.mjs` проверяет missing/old/future/typed versions,
CLI/preview без перезаписи профиля и независимость plugin/knowledge revisions;
`tests/test-setup-readiness.mjs` проверяет receipts без версии, v2 и v99 без
загрузки старых messages и без изменения файла.

Локально 2026-10-26 (Windows, Node 24) выполнено переключение интерпретатора
текущего working tree → Git `5738243` → working tree: предыдущая копия получена
через `git archive` во временный каталог с теми же bundled dependencies. На
синтетическом профиле `0.2` обе копии принимают контракт, предыдущая считает
readiness от изменённых skills устаревшей. Байты профиля, settings, исходника
и отдельного publication sentinel сохранены; внешние серверы не вызывались.
Это проверка совместимой ревизии кода и разделения состояния, а не доказательство
безопасности произвольного старого релиза или отката через настоящий UI хоста.

Data allowlist перечисляет только generic-профиль, recommended manifest и
runtime manifest. Фикстура с посторонними project bindings, private YAML corpus,
runtime owner и local settings не расширяет этот список. Checker проверяет
состав data-каталогов, MPL/NOTICE/Unicode и notices bundled dependencies;
schemas и обезличенные шаблоны остаются в ZIP. Произвольные YAML в data-каталогах
не становятся поставляемыми файлами автоматически.

`switching fresh plugin copies` в `tests/test-packaging.mjs` проверяет два новых
dev-destination с одним внешним state: settings сохраняют значения, профиль,
local/instance overrides, исходник, publication и runtime lock сохраняют байты.
Это проверка `prepare_install`, не обновления настоящего host cache. Разделение
checkout/cache/running MCP и порядок переключения описаны в [USAGE.md](USAGE.md).

Прогон 2026-10-26: `node tools/without-shells.mjs tools/test.mjs`, Windows x64,
Node `24.18.0`: 588 тестов, 587 pass, 0 fail, 1 skip (нативный UI focus/cancel
folder picker, отдельная опциональная интерактивная проверка). Wrapper запрещает
Python/PowerShell/Bash и shell; Git разрешён только для dev-метаданных и
изолированных Git-фикстур. Extracted smoke запускает поставленные MCP с одним
Node в PATH, без npm/install/компилятора на машине пользователя.

В `.github/workflows/build-plugin.yml` сохранена матрица Windows/Linux/macOS ×
Node 22/24; все шесть комбинаций используют те же verify/check и regression
entrypoints. Локально проверена её конфигурация и исполнение Windows/Node 24.
Остальные комбинации в этой сессии не запускались; успешный remote CI не
приписывается локальному прогону. Фактическая live-приёмка остаётся отдельной.
