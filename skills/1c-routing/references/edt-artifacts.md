# Специализированные сценарии EDT
Выбери только порученный сценарий с учётом knowledge gate и доступных
capabilities [routing](../SKILL.md); остальные специализированные routes не
являются обязательным preload или приёмкой этого действия.

Читай только раздел по задаче. Доступность операции, адресацию и defaults
устанавливай из живой schema/guide назначенного EDT; статического каталога или
зависимости от конкретной сборки нет. Общие binding, бюджет и unknown outcome
принадлежат [toolsets](toolsets.md), эффекты — [action policy](action-policy.md).
Persistent source/metadata changes проходят $1c-code-change.

## Внешние обработки и отчёты

Установи именно external-object project, qualified target, связанную базовую
конфигурацию и приложение. Linked base не становится владельцем external object;
готовый файл вне EDT-проекта — другой workflow. Метаданные, BSL и формы изменяй
по общим editing contracts с guards и focused проверками.

Для сборки уточни реальные эффекты текущего контракта: dumper может подготовить
или обновить build infobase; разрешение на исходник этого не покрывает. Если
selector использует простое имя, проверь коллизию обработки и отчёта. Не
превращай одну сборку в build-all. Предпочитай новую пустую staging-папку,
сохраняй существующий артефакт до проверки; replacement и запись build time в
метаданные должны входить в scope. Проверь созданный файл и итог owning job,
а не наличие output path. Debug launch следует [runtime](runtime.md).

## Локализация

Сначала установи объявленные языки, вид проекта, существующие dictionaries,
storage/provider topology и область передачи данных. Чтение настроек не
разрешает генерацию строк, запись словарей, overwrite или внешнюю передачу.
Работай только с разрешёнными human-facing полями; programmatic names, FQN,
BSL/query identifiers и platform tokens не переводятся.

Выполни нужную генерацию или перевод один раз по текущему контракту. Перед
readback дождись ready той же модели в bounded deadline; успешный ack не
доказывает готовность. Проверь representative localized fields и targeted diff/
diagnostics. Количество обработанных строк не доказывает качество перевода или
полный coverage. Недоступный provider останавливает только зависимую операцию.

## Формы, пакеты и связанные ресурсы

Для формы проверяй не только наличие узлов, но и ownership, attributes/data paths,
commands, handlers и refresh. У dynamic list проверь main table/custom query,
поля и visible bindings. Изменённый запрос проверяется в owning context; model
или screenshot не доказывают runtime interaction. У post-change render должна
быть актуальная модель/refresh согласно guide.

Для XML/XDTO, картинок, макетов, прав и command interface используй профильный
структурированный read/validator/writer, если он выражает задачу. Уточняй тип и
канонический адрес, не переключайся на сериализованные файлы. Package validation
состояния computed markers не заменяет свежую проверку после записи; undecided
или неполное покрытие не является valid. Извлечение бинарного ресурса не разрешает
перезаписать существующий файл; ограничивай выдачу нужным объектом/изображением.

## Сопровождение и внешняя помощь

Revalidation, quick fix, disk synchronization, project/infobase lifecycle и
import/export выбираются по фактическим effects. Preview/diagnostics не являются
разрешением применить fix или синхронизировать модель на диск. Для изменений
сохраняй targets, guards и итоговую проверку; не выполняй project-wide cleanup
ради локальной ошибки. Сравнение конфигураций следует [comparison](comparison.md).

Внешнего AI-помощника используй только по явному поручению: это дополнительный
расход лимита и возможная передача данных. Имя проекта в prompt не изолирует
доступные ему tools/files. Передай только bounded вопрос и разрешённые данные;
write-capable delegation требует доказанной технической границы доступа и
отдельного scope. Сохрани исходный job, проверь существенные выводы прямыми
read-only facts; повторный вызов не служит polling и не доказывает правильность.
