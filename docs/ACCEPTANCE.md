# Локальные проверки

Проверки ниже воспроизводятся из dev-checkout на изолированных фикстурах.
Они не подтверждают качество внешнего корпуса или live-приёмку установленного
плагина, EDT, v8std, JAR и хоста Codex.

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

Поведенческие задачи и скрытые от исполнителя эталоны:
`tests/behavioral/` только в dev-checkout, не в ZIP. Проверяются выбор механизма,
достаточность, L/M/H по последствиям и остановка поиска/декомпозиции. Это отдельный
качественный smoke-прогон инструкций, а не автоматическая или live-приёмка.
Отдельные задачи покрывают похожий, но неприменимый API, обоснованный новый код,
гарантию типа и недоверенный ввод. Известный подходящий API проверяется без
повторного поиска.
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
