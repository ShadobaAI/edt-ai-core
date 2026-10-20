# Независимое ревью результата

Передай свежему reviewer acceptance criteria и SDD/ADR, если они требуются
проектом, final diff с base/target SHA для сохранённых ревизий либо baseline/
result hashes для незакоммиченного результата. Commit ради ревью не требуется.
Передай допустимые source evidence, selections и точные нормы, ledgers только
применимых фаз, реальные diagnostic/test outcomes и существенные пробелы. Не передавай
ожидаемый вердикт или implementation reasoning как доказательство корректности.

Дай явное read-only задание и, когда host позволяет, read-only sandbox/agent
configuration. Название роли не доказывает техническое ограничение доступа;
если sandbox недоступен, явно укажи границу enforcement. Плагин не регистрирует
скрыто CRM/Kafka agent names или пользовательские agent settings.

Reviewer проверяет changed behavior и достижимые failure paths, authority/scope,
concurrency, нормативную применимость, enclosing invariants, согласованность
фактических результатов с критериями. Passing tests и слова implementation
agent не доказывают корректность. Missing authority останавливает зависимый
вывод, а не разрешает другую authority или generic filesystem source access.

Запрещены source/metadata writes, runtime evaluation, запуск/обновление базы,
смена ветки, deployment и cutover. Нельзя делать fixes в ходе review.
Нужны actionable findings: location, priority, сценарий, последствие и evidence;
отдельно material unknowns/unperformed checks. Отсутствие находок формулируется
с фактическими границами проверки, не как полная приёмка недоступных gates.
