# Comparison и decision files

Сверь guides `compare_configurations`, `get_comparison_node`, `merge_rules`.
Comparison/rules authoring не выполняет merge. Точно установи project,
other/ancestor revisions и bounded scope; current side включает uncommitted model.

Начни comparison один раз, сохрани job/comparison IDs, дождись finished tree и
читай только нужные nodes. Неполный tree не доказывает отсутствие различий.
Чтение rules не разрешает их запись. Для validation передай finished comparison ID;
`NOT VALIDATED` не является принятым планом. Сохраняй прежние decisions через
`basedOn`; overwrite требует scope на тот же файл. Следуй текущему guide для ZIP
addressing, не переноси decisions на другие revisions по совпадению entry names.

EDT имеет общий comparison slot: освободи только finished comparison этой задачи
по сохранённому ID после нужной validation. Не закрывай чужую сессию. Отчитайся
отдельно о comparison, rules validation и фактически выполненном merge, если он
вообще был отдельно разрешён и выполнен.
