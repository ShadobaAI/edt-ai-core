# Readiness после изменения HEAD

Это bounded read-only ожидание последствий собственных разрешённых checkout/
pull/fast-forward. Исходная infrastructure failure не превращается в ожидание
сборки. До Git-подготовки маршрут уже должен быть проверен.

Для каждого этапа сохрани уникальный stage, HEAD SHA, exact repository/EDT URL
текущего экземпляра и список `{projectName, expectedPath}` только затронутых
проектов. Один managed poller на stage; прежний заверши до следующей смены HEAD.
Используй существующий MCP, live schema `list_projects` и structured results,
не запускай новый EDT или альтернативный HTTP process ради ожидания.

Каждый успешный полный ответ должен подтвердить единственное совпадение имени,
нормализованный абсолютный path, `open=true` и EDT nature. `building` и переходный
`unknown` допустимы только для продолжения этого опроса, не для source reads.
Только все `ready` для текущего stage/HEAD разрешают зависимый анализ.
Missing/duplicate project, path/nature mismatch, закрытый проект, транспортная
ошибка, неполный response или иной unusable state немедленно блокируют stage.

Задай конечный deadline (по умолчанию 15 минут, если проект не определяет иной).
Опрос не чаще раз в 10 секунд; сообщай изменения состояния, сохраняй последний
полный ответ. Running exec cell продолжай тем же `wait`/ID без новых pollers;
короткие waits позволяют сообщения пользователю. Timeout/отмена — не ready;
старый ready после смены HEAD, instance URL или stage не переиспользуется.
При blocker сообщи инструмент, route/stage/HEAD, последнее состояние и причину.

Независимую read-only работу можно продолжать во время building, когда она не
требует новой модели. Ready не доказывает write readiness и не разрешает запись.
