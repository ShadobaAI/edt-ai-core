# YaXUnit workflow

## Create/change

1. Установи ожидаемое поведение и минимальные inputs/outcomes; выбери связанные
   fixtures и isolation по parent skill. Через profile-bound alias найди тесты;
   production dependency исследуй лишь для конкретного нерешённого факта.
2. Выбери общие и YaXUnit требования по единому normative workflow. Проверь
   предложение, declarative registration, export/context, fixture ownership,
   deterministic setup, assertion semantics и fluent hierarchy до записи.
3. Получи focused EDT baseline и source guard; измени только назначенное тестовое
   расширение через EDT по $1c-code-change. Test-only файл не доказывает L: запросы,
   state и production contract проверяются по реальным механизмам.
4. На фактическом результате проверь затронутые authoring items, выполненные
   proposal/result compliance и те же EDT diagnostics. Новые механизмы требуют
   пересмотра selection. Runtime pass не заменяет нормативную проверку.
5. Для нужного и разрешённого запуска прочитай живой guide `run_yaxunit_tests`: выбери точные project,
   launch configuration и минимальный module/test filter. Установи эффекты
   обновления БД, записи тестовых данных, запуска или перезапуска клиента и user agreement по
   общей action policy. Не запускай всё расширение по умолчанию.
6. Запусти один раз, сохрани `jobId` и следи за этим job через поддержанный status.
   Timeout не разрешает повторный запуск; сначала установи outcome/state.
   Сопоставь результат с тем же project/filter/run, counts и фактическими assertions.
   Неожиданный нулевой count, skipped/незавершённый run или missing report — не pass.

## Design/review

Design проверяет конкретное предложение с proposal ledger без записи/запуска.
Review проверяет существующий тест/ревизию с result ledger без proposal и fixes.
Отсутствие runtime не останавливает доступную статическую проверку. Общий oneC
workflow и test patterns применяй к тому же предмету/фазе; не отправляй `debug`
или `migrate` как operation в oneC selector, где таких значений нет.

## Run/report/debug

Run/report-only использует установленный test scope без authoring gate, пока
не требуется изменить тест. Отделяй подтверждённый отчёт этого run от старых
файлов. Сохраняй результат/ссылку в `yaxunit_config.results`, указывай фактические
counts, время, выбранный фильтр и job ID; не включай credentials.

До изменения кода классифицируй отказ: test, product, data/environment или runner.
Debug без разрешения на исправление остаётся диагностикой. Перезапуск и изменение
данных сохраняют action policy независимо от имени режима.
Читай только нужный для этой причины source. Testability препятствие следует
[testability](testability.md); оно не расширяет разрешение на production.
При debug прочитай общий [runtime contract](../../1c-routing/references/runtime.md).
Не отключай break-on-error глобально как routine prerequisite. Сохраняй исходные
breakpoints и восстанавливай реальное прежнее состояние временных изменений.

Read-only review сообщает findings без fixes и без обязательного runtime запуска.
Если нужная проверка недоступна, назови точную причину и границу вывода.
