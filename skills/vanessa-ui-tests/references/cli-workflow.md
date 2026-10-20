# Bundled CLI и editor transition

Для `call --arguments-file` Python разрешает путь от каталога вызова один раз,
сохраняет hash bytes в scope и передаёт Node абсолютный путь и ожидаемый hash.
Node проверяет hash того же прочитанного buffer до dispatch и использует его
parsed arguments без повторного чтения. Изменение файла требует нового describe
и проверки согласования; смена cwd не должна менять исполняемый payload.

В plugin root доступен `scripts/vanessa.py`; он проверяет enabled capability,
schema local runtime, соответствие project/features/results/server binding и
общую action policy до dispatch. Путь plugin root получай из установленного
пакета, не ищи toolkit в Kafka checkout.

```text
python <PLUGIN_ROOT>/scripts/vanessa.py describe --project-root PROJECT --feature RELATIVE_FEATURE --scenario EXACT_NAME
python <PLUGIN_ROOT>/scripts/vanessa.py doctor --project-root PROJECT
python <PLUGIN_ROOT>/scripts/vanessa.py list --project-root PROJECT
python <PLUGIN_ROOT>/scripts/vanessa.py run --project-root PROJECT --feature RELATIVE_FEATURE --scenario EXACT_NAME --authorization-file APPROVAL_JSON
```

Относительный `--feature` считается от `projectRoot`. Допустимы файлы в
настроенном `features` и явно выбранные временные копии внутри проекта, например
`.local/repair.feature`. `describe` и `run` проверяют одну область: путь после
разрешения ссылок остаётся внутри проекта и имеет расширение `.feature`.

`describe` не запускает приложение и выводит точный scope/effects записи
авторизации; для другого действия используй `describe --for-action start|setup|connect|call`.
`APPROVAL_JSON` имеет `effects`, `scope`, `authorizations` по
`policy.check_action`; evidence ссылается на реальное разрешение человека для
этой области. Не создавай его как замену согласованию и не расширяй старое
разрешение. `configure` только показывает настройки; `start/setup/connect`
могут запускать клиент/manager и изменять runtime, поэтому требуют нужных effects.
Для generic `call` effects установи по живой schema/guide и actual arguments.

`run` удерживает общий endpoint/TestClient lock от полной readiness до reload,
syntax, независимой selection/content проверки, запуска выбранного scenario и
получения результатов. Timeout не повторяет mutation. Проверяется соответствие
исполненного содержимого хешу файла. Автоматический receipt остаётся unverified
до проверки настоящего test outcome.

Bundled wire adapter проверен на Vanessa Single 1.2.043.45 / MCP 1.31; другие
версии не считаются совместимыми по одному tools/list. Native workflow допускает
другую версию по её документированному контракту. Не отключай version gate CLI.

Если manager в tree mode, используй `run ... --editor-transition` с открытым
stdin. Под тем же lock/session ожидается максимум 60 секунд:

1. Получи `awaiting_editor_enable` и проверь manager/profile/PID.
2. Доступным UI-инструментом наблюдай именно этот manager и его фактический
   элемент «Перейти в Vanessa Editor»; выполни только этот переход.
3. Передай одну строку `{"action":"continue"}`. Успешный `open_feature_file`
   подтверждает editor availability; cached content её не доказывает.
4. Проверь syntax, selection, actual content и results. После run верни tree mode
   наблюдаемым control и получи полное state перед новой цепочкой.

Не продолжай после посторонних UI-действий, неоднозначного окна, истёкшего wait
или неизвестного исхода. Без UI capability останови переход, не перезапускай
manager вместо него и не выдумывай readiness.
