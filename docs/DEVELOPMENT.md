# Разработка и выпуск

## Окружение

Для локальных регрессий нужны Node.js 22+ и Git; в CI настроены Node 22
и 24 на Windows, Linux и macOS. Внешние EDT/v8std и Java нужны для соответствующих
live-проверок; обычные регрессии используют тестовые данные и локальные серверы.

Установите зависимости разработчика и создайте автономный bundle:

```text
npm ci --ignore-scripts
node tools/vendor.mjs
```

`package-lock.json` фиксирует версии и npm integrity. `vendor.mjs` собирает
YAML/Ajv/ZIP в ESM bundle, копирует лицензии и проверяет SHA-512 двух готовых
Windows N-API модулей Koffi по lockfile. Кэш загрузок находится в `.work/`.
Компилятор, Python, PowerShell и Bash не нужны. `vendor/` генерируется и входит
в готовый ZIP; `node_modules`, esbuild и инструменты разработчика туда не входят.

## Проверки

```sh
node tools/test.mjs
```

Усиленный прогон с `PATH`, содержащим только Node (Git используется по явно
разрешённому абсолютному пути для сборочных фикстур):

```text
node tools/without-shells.mjs tools/test.mjs
node tools/without-shells.mjs tools/vendor.mjs
node tools/without-shells.mjs tools/package-plugin.mjs
```

Для небольшой правки запускайте относящиеся к ней тесты. Полная регрессия
выполняется в CI. Live-проверки описаны в [руководстве](USAGE.md);
подтверждённые результаты и ограничения — в [журнале](VERIFICATION.md).

## Локальная сборка

```sh
node tools/package-plugin.mjs
# Явная версия для локальной проверки:
node tools/package-plugin.mjs --version 0.2.1
```

Сборщику нужны Node.js, Git и заранее созданный `vendor/`.
`node tools/develop.mjs build` обновляет bundle перед сборкой.
`bash tools/build-plugin.sh` сохранён по запросу как необязательная обёртка
dev-контура над этими Node-командами. Локальная сборка ничего не публикует.

В `.build/` появятся:

- `1c-ai-core-VERSION.zip` — плагин;
- `1c-ai-core-VERSION-marketplace.zip` — локальный магазин с плагином;
- `SHA256SUMS` — контрольные суммы;
- `marketplace/` — готовый каталог локального магазина.

Сборщик пересоздаёт `.build/`. Локальная версия берётся из максимального
стабильного тега, достижимого из HEAD, а до первого тега — из `plugin.json`.
Сборка работает до первого коммита. `build-info.json` фиксирует версию,
ревизию, незакоммиченные изменения и ID запуска CI. В пакет входят `LICENSE`,
`NOTICE.md` и `SOURCE.md` со сведениями об исходниках сборки.

Проверьте запуск плагина и отдельно — контрольные суммы и распаковку.
Для распаковки укажите новый, ещё не существующий каталог:

```sh
node tools/check-plugin.mjs .build/marketplace/plugins/1c-ai-core
node tools/verify-package.mjs .build ".work/extracted plugin"
```

Проверка пакета запускает entrypoints вне checkout, с Unicode и пробелами в путях,
`PATH` только с Node и перехватом запрещённых процессов/shell-вызовов. Она проверяет
импорт/экспорт настроек, CLI профиля, все MCP-входы и guard, без установки npm.
Сам smoke выполняется в отдельном Node-процессе, чтобы Windows освободила N-API DLL.

Состав пакета задаётся в `scripts/package_layout.mjs` и используется как
`tools/package-plugin.mjs`, так и локальным `prepare_install.mjs`.
Изменяя его, сохраняйте
переносимую команду `node` и исключайте локальные настройки,
credentials и инструменты разработки; runtime-зависимости поставляются внутри.
Проектные профили принадлежат
репозиториям проектов; здесь поставляется только `generic-1c`.

## CI и публикация

**Build 1c-ai-core plugin** запускается для PR и push стабильного тега
`MAJOR.MINOR.PATCH` без `v`. Обычный push ветки сборку не запускает.
Workflow проверяет регрессии, собирает ZIP и хранит их вместе с `SHA256SUMS`
в Actions artifact `1c-ai-core-plugin` 14 дней. Распакованный пакет проверяется
в матрице Windows/Linux/macOS и Node 22/24. Все `run`-шаги используют `node {0}`;
workflow не требует Bash или PowerShell для скриптов плагина.

После успешного завершения всей сборки тега **Publish 1c-ai-core to codex-plugins**
обновляет `plugins/1c-ai-core` и его запись в каталоге
[ShadobaAI/codex-plugins](https://github.com/ShadobaAI/codex-plugins).
PR-сборки не публикуются.

Для выпуска:

1. Добавьте в Actions secrets исходного репозитория `MARKETPLACE_TOKEN`:
   fine-grained token для `ShadobaAI/codex-plugins` с правом **Contents: Read and write**.
   Ветка `main` магазина должна разрешать push владельцу токена.
2. Отправьте проверенные исходники в `main`.
3. Создайте свободный тег версии и отправьте его. Например, если `0.2.1` ещё не занят:

   ```sh
   git tag 0.2.1
   git push origin 0.2.1
   ```

Версия релиза берётся из запускающего тега. Публикация проверяет репозиторий,
workflow, ревизию, тег, run ID, чистоту сборки и содержимое архивов.
Код из артефакта с токеном публикации не исполняется.
Git-аутентификация передаётся отдельным source/marketplace процессам через
временные HTTP headers окружения; shell credential helper не устанавливается.
Повторный выпуск той же сборки ничего не меняет; замена версии и откат запрещены.
Для повторной попытки запустите workflow публикации вручную с `build_run_id`
успешной сборки тега.

## Документация

[Инструкция пользователю](USAGE.md), [архитектура](https://github.com/ShadobaAI/edt-ai-core/blob/main/docs/design/ARCHITECTURE.md),
[техническая схема](https://github.com/ShadobaAI/edt-ai-core/blob/main/docs/design/TECHNICAL_ARCHITECTURE.md), [план развития](ROADMAP.md).
Архитектурные документы включают будущие возможности; фактическая готовность
отмечена в [журнале проверок](VERIFICATION.md).
