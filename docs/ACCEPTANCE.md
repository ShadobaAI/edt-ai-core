# Локальные проверки

Локальные проверки выполняются на изолированных фикстурах в рабочей копии
исходников. Они проверяют контракты и поведение плагина, но не заменяют
приёмку установленного пакета и внешнего окружения.

| Область | Проверки в исходниках |
| --- | --- |
| Профили, пути, изоляция и защита исходников | `tests/test-profiles.mjs`, `tests/test-profile-settings.mjs`, `tests/test-profile-layers.mjs` |
| Настройка и готовность компонентов | `tests/test-setup.mjs`, `tests/test-setup-readiness.mjs`, `tests/test-yaxunit-readiness.mjs` |
| База знаний, публикация и разграничение доступа | `tests/test-knowledge.mjs`, `tests/test-knowledge-settings.mjs`, `tests/test-knowledge-contracts.mjs`, `tests/test-openviking-store.mjs`, `tests/test-openviking.mjs`, `tests/test-publication.mjs` |
| Процессы, runtime, индекс и ресурсы | `tests/test-processes.mjs`, `tests/test-runtime.mjs`, `tests/test-index-readers.mjs`, `tests/test-bsl-ls-proxy.mjs` |
| Vanessa и обмен MCP-сообщениями | `tests/test-vanessa-isolation.mjs`, `tests/test-mcp-codec.mjs` |
| Форма и диагностика | `tests/test-settings-ui.mjs`, `tests/test-settings-scopes.mjs`, `tests/test-diagnostics.mjs` |
| Состав поставки и Node-only окружение | `tests/test-packaging.mjs`, `tests/test-node-only-runtime.mjs` |
| Инструкции навыков, заголовки документации, пояснения схем и основные ошибки профиля | `tests/test-language.mjs` |

Полный набор запускается командой:

```sh
node tools/test.mjs
```

Проверки базы знаний можно запустить отдельно:

```sh
node --test tests/test-knowledge.mjs tests/test-knowledge-settings.mjs tests/test-openviking-store.mjs tests/test-openviking.mjs tests/test-publication.mjs
```

Поведенческие проверки инструкций выполняются отдельно по
`tests/behavioral/README.md`. Они находятся только в исходниках и не входят
в ZIP. Это качественная проверка поведения агента, не автоматическая приёмка
плагина или испытание реального окружения.

Проверки поставки используют временную копию исходников. Они сверяют разрешённые
файлы и запускают извлечённые MCP с включёнными зависимостями без внешних
серверов; пользовательский кэш плагина при этом не обновляется. Состав и порядок
ручной проверки пакета описаны в [руководстве разработчика](DEVELOPMENT.md).

Регистрация `PreToolUse` и работа guard на локальных фикстурах проверяются
отдельно от активации hook настоящим хостом. Проверки формы используют тестовую
DOM-среду; нативные окна и их взаимодействие с Codex требуют отдельной
интерактивной проверки.

Успешные локальные проверки не подтверждают качество внешнего корпуса знаний,
фактические права сервера, активацию hooks, работу EDT и v8std, применение
конфигурации BSL LS или выполнение тестов YaXUnit и Vanessa. Эти свойства
проверяются в соответствующем реальном окружении.
