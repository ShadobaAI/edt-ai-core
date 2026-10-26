# Пример мультирепозиторного рабочего пространства

Пример показывает целевой формат рабочего пространства. Текущая архитектура
плагина описана в [технической архитектуре](../../docs/ARCHITECTURE.md).
Формат 1c-ai.workspace/v1 ещё не реализован текущим загрузчиком.
Файлы не предназначены для импорта через `scripts/profile.mjs`.

Здесь workspace-config и шесть папок repositories являются макетами независимых
Git checkout. Они намеренно не содержат .git, 1С-метаданных и исполняемых тестов.
У реального продукта каждая папка получается из своего clone/worktree; расположение
может отличаться и задаётся локальными bindings, включая разные диски.

- [workspace.yaml](workspace-config/.ai/workspace.yaml) — общие компоненты, связи,
  EDT bindings, assemblies, test/build profiles и области знаний.
- [workspace.local.example.yaml](workspace-config/.ai/workspace.local.example.yaml)
  — пример расположений, URL, builders, тестовых сред и ссылок на secrets.
- [dev-b.example.yaml](workspace-config/.ai/instances/dev-b.example.yaml)
  — второй экземпляр с другими EDT URL.
- [plugin.settings.example.yaml](plugin.settings.example.yaml) — пользовательские
  настройки runtime, лимитов, интерфейса и логирования.

В этом варианте base — конфигурация поставщика, product — собственное расширение,
patch — патч-расширение, unit-tests — тестовое расширение, framework — YaXUnit,
ui-tests — Gherkin features Vanessa. Для продукта, который владеет основной
конфигурацией, его component имеет kind configuration и соответствующего владельца.

Source roots src/ и features/ обозначены .gitkeep. Файл descriptor внутри каждой
папки показывает явную связь с workspace за границей отдельного Git repository.

Для подключения реального проекта мастер должен создать workspace.local.yaml,
зарегистрировать разрешённые checkout roots, подтвердить реальные EDT projects,
выбрать установленную платформу и заполнить хранилище credentials. URL, проекты,
порты и executable в примере не являются настройками текущей машины. Путь
CHOOSE-IN-UI и домен example.invalid намеренно неработоспособны.

Порядок extensions задаёт состав, а применимость и фактический порядок активации
подтверждает assembly adapter по возможностям платформы. Тесты обязаны подтвердить,
что test projections и ИБ соответствуют тем же входным snapshots/артефактам.

Декларация не разрешает запись или запуск: TaskContext и реальные согласования
определяют допустимые действия. Публикационные ключи OpenViking отсутствуют.
