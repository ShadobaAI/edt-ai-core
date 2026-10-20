# Разработка и выпуск

## Окружение

Для локальных регрессий нужны Python 3.12+ и Node.js; в CI проверяются Node 22
и 24 на Windows и Linux. Внешние EDT/v8std и Java нужны для соответствующих
live-проверок; обычные регрессии используют тестовые данные и локальные серверы.

Создайте и активируйте виртуальное окружение, затем установите зависимости.
Пример для PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

В Bash на Linux/macOS окружение активируется командой `source .venv/bin/activate`.
Если активация недоступна, вызывайте интерпретатор из `.venv` напрямую.

## Проверки

```sh
python -m unittest discover -s tests -p 'test_*.py'
node --test tests/test-bsl-ls-proxy.mjs tests/test-settings-ui.mjs
node tests/test-vanessa-ui.mjs
```

Для небольшой правки запускайте относящиеся к ней тесты. Полная регрессия
выполняется в CI. Live-проверки описаны в [руководстве](USAGE.md);
подтверждённые результаты и ограничения — в [журнале](VERIFICATION.md).

## Локальная сборка

```sh
bash tools/build-plugin.sh
# Явная версия для локальной проверки:
bash tools/build-plugin.sh --version 0.2.1
```

Сборщику нужны Git и Python 3.10+. В Git Bash можно указать интерпретатор через
`PYTHON`. Без Bash используйте `python tools/package-plugin.py` с теми же аргументами.
Локальная сборка не запускает CI и ничего не публикует.

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
python tools/check-plugin.py .build/marketplace/plugins/1c-ai-core
python tools/verify-package.py .build '.work/extracted plugin'
```

Состав пакета задаётся в `tools/package-plugin.py`. Изменяя его, сохраняйте
переносимые команды `python`/`node` и исключайте локальные настройки,
credentials, зависимости и инструменты разработки. Проектные профили принадлежат
репозиториям проектов; здесь поставляется только `generic-1c`.

## CI и публикация

**Build 1c-ai-core plugin** запускается для PR и push стабильного тега
`MAJOR.MINOR.PATCH` без `v`. Обычный push ветки сборку не запускает.
Workflow проверяет регрессии, собирает ZIP и хранит их вместе с `SHA256SUMS`
в Actions artifact `1c-ai-core-plugin` 14 дней. Распакованный пакет проверяется
на Windows/Linux и Node 22/24.

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
Повторный выпуск той же сборки ничего не меняет; замена версии и откат запрещены.
Для повторной попытки запустите workflow публикации вручную с `build_run_id`
успешной сборки тега.

## Документация

[Инструкция пользователю](USAGE.md), [архитектура](design/ARCHITECTURE.md),
[техническая схема](design/TECHNICAL_ARCHITECTURE.md), [план развития](ROADMAP.md).
Архитектурные документы включают будущие возможности; фактическая готовность
отмечена в [журнале проверок](VERIFICATION.md).
