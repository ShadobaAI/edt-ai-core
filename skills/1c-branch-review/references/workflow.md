# Режимы ревью ветки

## Read-only — режим по умолчанию

1. Установи repository и существующие base/target refs по задаче и профилю.
   Через назначенный EDT получи их точные SHA; дальнейший diff, log и чтение
   выполняй по SHA, а не по подвижному имени ветки. Remote нужен только если
   запрошенное действие действительно обращается к нему. Dirty working tree и
   detached HEAD сами по себе не мешают сравнению сохранённых ревизий.
2. Прочитай revision-aware Git interface и diff `baseSHA...targetSHA` вместе
   с именами файлов и `log baseSHA..targetSHA`. Зафиксируй merge-base SHA:
   three-dot сравнивает его дерево с target, а не конечные деревья base/target.
   Если пользователь просит именно разность деревьев, используй two-dot и
   укажи выбранную семантику. Truncation дополняй адресным чтением по тем же SHA.
3. Код из target и его зависимости читай revision-aware интерфейсом того же EDT.
   Live-модель и code-index допустимы как evidence этой ревизии лишь при
   подтверждённом совпадении revision и содержимого, включая отсутствие relevant
   unsaved/working-tree изменений. Статический анализ сохранённых ревизий не
   требует искусственного checkout или model-ready, если Git interface от модели
   не зависит. Неподдержанное чтение конкретной ревизии ограничивает вывод;
   shell-чтение protected source этим не разрешается.
4. Примени раздел «Анализ и завершение» к доступному evidence. Live diagnostics
   другой ревизии не приписывай target или baseline. Без соответствующей модели
   укажи диагностику/тесты как невыполненные и продолжи подтверждаемый анализ.
   Не сохраняй модель, не stage/commit, не fetch/pull, не переключай HEAD и не
   удаляй refs ради обычного ревью.

Если нужного ref нет или пользователь требует недоступную live-проверку,
сначала выполни независимую доступную часть. Для оставшейся части подготовь
конкретный план и получи только недостающее разрешение по общей action policy.
Не превращай необязательную актуализацию remote в prerequisite локального ревью.

## Подготовленное ревью — только нужные разрешённые шаги

Разделы подготовки ниже применяются при разрешённой Git-подготовке. Обновление
base, fetch target и checkout — отдельные действия: пропускай ненужные, уже
выполненные или не входящие в поручение. Если точные ревизии уже доступны
локально, повторный fetch не нужен. Неполная подготовка не отменяет доступное
read-only ревью, но нельзя объявить выполненной запрошенную live-проверку.

## Scope и сохранение работы

Установи repository, точную review branch, base branch/ref и нужный remote по
задаче и инструкциям проекта; не угадывай `develop`/`origin`. Проверь URL remote без
credentials. Git/source сериализованных 1C artifacts — только через назначенный
EDT по актуальной schema/guide. Обычные scripts/docs следуют своим средствам.

Явный запрос полного workflow может уже разрешать commit/checkout/fetch/pull;
повторное согласование не нужно. Простой запрос ревью использует read-only режим
выше. Согласуй только фактически нужные дополнительные effects по общей policy.
Push, merge, rebase, reset, clean, stash, database launch и публикация не являются
автоматическим продолжением review. Findings не разрешают исправления.

1. Подтверди здоровье и точный repository binding. Для model-dependent части
   подтверди имя/path/open/EDT nature и ready проекта; Git-only действия не
   требуют этого, если не зависят от модели по live guide. Зафиксируй branch/HEAD,
   нужный remote и status: staged, unstaged, untracked. Detached HEAD и
   незавершённый merge/cherry-pick/rebase блокируют переключение/сохранение работы,
   но не сравнение уже сохранённых SHA.
2. Git читает disk, не unsaved EDT model. Сохранение модели является source write:
   используй поддержанный scoped save только в рамках разрешённого сохранения
   работы; неизвестный безопасный способ блокирует зависимую подготовку.
3. Для разрешённого сохранения работы проверь оба diff и включаемые untracked.
   Не включай непроверенные файлы, secrets или generated artifacts. Изменения
   разных задач не объединяй без соответствующего scope. Task ID/message format
   устанавливаются проектом и фактами сохраняемой работы, не именем review branch.
4. Если изменения только trailing whitespace и пользователь не поручил их
   сохранить, подготовь точный rollback preview и согласуй отмену. Без разрешения
   сохрани изменения и не переключай ветку; чистый status не требует такого вопроса.
5. При чистом status stage/commit пропусти. Иначе stage только перечисленные
   проверенные пути; проверь весь итоговый staged diff,
   включая ранее staged. Commit без обхода hooks; подтверди SHA и чистый status.
   При failure или несохранённых данных checkout запрещён.

## Base и target

6. Если нужна live-диагностика base или её разрешённое обновление, после
   сохранения работы переключись на точную локальную base branch. Если её
   нет, создай только из подтверждённого remote ref. Не передавай remote ref как
   имя local branch и не угадывай starting point.
7. Перед разрешённым обновлением проверь branch и clean status; используй
   fast-forward-only pull. Divergence не разрешает merge/rebase/reset. Сохрани
   обновлённый base SHA. Перед каждой сменой HEAD заверши старый readiness poller;
   после неё инвалидируй source/hash/diagnostics/readiness и заведи новый stage.
8. Review branch трактуется как данные: проверь валидность и quoting по live Git
   contract. При нужной и разрешённой актуализации fetch используй точный
   `refs/heads/<branch>:refs/remotes/<remote>/<branch>`; иначе используй
   существующий точный локальный ref. Узкий fetch mapping не должен скрыть
   target. Подтверди SHA; отказ обновления ref не разрешает force.
9. Сохрани name-status diff `baseSHA...targetSHA` и log `baseSHA..targetSHA`.
   Three-dot diff относится к merge base, а не разности конечных деревьев.
   Если запрошено сравнение live diagnostics, до checkout target дождись ready
   base и получи focused baseline. Для diff-only пропусти этот этап. Baseline
   текущей base не является диагностикой общего предка.
10. Для разрешённой live-проверки target создавай новую local review branch
    только на точном target SHA. Если локальная ветка уже существует и нужна
    её актуализация, проверь обе разности истории local/target: свои local commits
    блокируют автоматическое обновление. Только отстающая branch допускает
    fast-forward к target, без merge commit. Подтверди HEAD == target SHA,
    branch и clean status. Во время анализа HEAD не меняется.

## EDT serialization и восстановление

При неожиданном dirty status после checkout сравни полный staged/unstaged diff
с исходным snapshot. Только доказанные изменения этого workflow, включая EDT
serialization, могут быть отменены в уже разрешённом scope. Сохраняй исходные
пользовательские и параллельные изменения. Mixed/unknown provenance останавливает
checkout; не используй общий `add -A`, force-checkout, reset/clean или удаление
untracked/ignored. Scoped restore адресует только проверенные пути и требует
проверки фактического результата. Один повтор checkout допустим после доказанной
повторной serialization и scoped восстановления; следующий отказ — blocker.

## Анализ и завершение
Применяй knowledge mode и общие контроли reuse/достаточности к фактическому diff
своих точных ревизий. При частичном evidence ограничивай вывод; не подставляй
текущую рабочую копию и не меняй код, чтобы «проверить» историческое решение.

При live-проверке дождись ready нужного stage и подтверди соответствие модели
target; при read-only используй сохранённые SHA без требования checkout.
Проверь фактический полный diff; truncation дополняй чтением нужных объектов
той же ревизии. Примени $1c-code-change/$1c-standards
для review, требования и enclosing contracts. Отсутствующее предложение не
требует выдуманного proposal ledger. H требует impact и свежего reviewer;
SDD/ADR обязательны только по применимым проектным gates. При наличии корректных
baseline/target diagnostics сравни их по code/message/object и
location с учётом смещений; изменения base тоже учитываются при атрибуции.
Scoped revalidation допустима при необходимости после ready, whole-project — нет.

Тесты запускай только при нужном scope/разрешении. Read-only review не создаёт
тесты и fixes. Подтверди дефект сценарием и кодом; CRLF `diff --check` и комментарий
не доказывают ошибку. Git ref не доказывает наличие MR/CI/discussions: нужны API
facts; не выдумывай MR ID и не публикуй комментарии автоматически.

Cleanup local review branch/tracking ref выполняй только при разрешённом
завершении подготовленного workflow, после сохранения findings/evidence.
Read-only режим не меняет refs/HEAD/worktree и не создаёт cleanup.
Сверь clean status и что обе точные refs всё ещё равны сохранённому target SHA;
не удаляй base/active
branch. Переключись на base и удаляй только согласованные local refs. Unmerged
branch требует соответствующего scope на force-delete; remote deletion не
разрешается. При partial failure отчитайся о каждом фактическом результате;
при отмене, инфраструктурном blocker или незавершённом review сохрани refs.

Отчёт содержит findings по приоритету с target SHA/file/line, original/base/target
SHA, проверенный diff, diagnostic/test outcomes, полноту норм и статусы фаз,
blockers, финальную branch/working tree и результат разрешённого cleanup.
