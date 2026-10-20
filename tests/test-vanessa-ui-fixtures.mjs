// Sanitized live MCP 1.31 responses (Vanessa Single 1.2.043.45), 2026-10-15.
// Database/profile/user names are synthetic; no external checkout/runtime is read.
export const response = text => ({ content: [{ type: "text", text }] });
export const environment = response(`# Данные об окружении

- Текущая дата и время: 15.10.2026 22:22:51

## Информация о платформе
- Платформа: 8.5.1.1423

## Операционная система
- Данные ОС: Windows x86-64

## Vanessa Automation
- Это Vanessa Automation Single
- Версия: ver 1.2.043.45
- Версия MCP: 1.31

## Внешняя компонента VanessaExt
- Включено использование внешней компоненты VanessaExt: Да

## Менеджер тестирования
- Строка соединения с информационной базой: Srvr="localhost";Ref="ui-demo";`);
export const state = response(`# Состояние Vanessa Automation

- Выполнение сценариев: нет
- Клиент тестирования подключен: нет
- Включена запись действий пользователя: нет
- Каталог фич: 
- Каталог проекта: C:\\Projects\\UI Demo

## Текущая фича
- name: не указано
- fullPath: не указано
- language: ru
- tags: не указано

## Текущий сценарий
- name: не указано
- id: не указано
- result: не указано
- tags: не указано
- retryNumber: не указано

## Текущий шаг
- name: не указано
- paramValues: не указано
- lineNumber: не указано
- id: не указано
- status: не указано

## Следующие шаги
- Загрузите фичи: \`load_features\`
- Подключите клиента тестирования: \`manage_test_client\` с \`action: connect\``);
export const profiles = response(`# Список профилей клиентов тестирования

Найдено профилей: 1

## Профиль: ExistingClient

| Свойство | Значение |
|----------|----------|
| Имя | ExistingClient |
| Синоним |  |
| Строка подключения | Srvr="localhost";Ref="ui-demo"; |
| Дополнительные параметры | /N"FixtureUser" |
| Тип клиента | Тонкий |
| Имя компьютера | localhost |
| Дескриптор окна | 0 |
| PID | 0 |
| Статус | ❌ не подключен |
`);
export const editor = response(`# Состояние редактора

## Открытые вкладки
Количество: 1

- **→** memory:welcome

## Активный документ

### Выбранный сценарий: Нет выбранного сценария. Можно запустить все сценарии на выполнение с помощью

### Всего сценариев в файле: 0
### Все сценарии из файла:

## Ошибки в редакторе
Количество: 0`);
export const connectedState = response(state.content[0].text
  .replace("Клиент тестирования подключен: нет", "Клиент тестирования подключен: да")
  .replace("Включена запись действий пользователя: нет", "Включена запись действий пользователя: нет\n  - Имя профиля клиента тестирования: TestClient"));
export const extensions = response("# Список расширений, установленных в базе\n\n" + [
  ["ApplicationExtension", "9.9.9.9"], ["client_mcp", "0.6.6"], ["TestDataExtension", "9.9.9.9"],
  ["DeveloperTools", "8.22.1e"], ["GeneralTools", "26.5.1"], ["VAExtension", "1.41"], ["VA", "1.2.043.45"],
].map(([name, version], i) => `## ${i + 1}. ${name}\n\n| Свойство | Значение |\n|----------|----------|\n| Имя | ${name} |\n| Версия | ${version} |\n| Назначение | Дополнение |\n| Активно | да |\n| Безопасный режим | Нет |`).join("\n\n") + "\n\n## Итого: 7 расширений\n");
export const clientProcess = response(`# Список процессов ОС

Найдено по отбору: 1 из 2. Показано: 1.
Режим: только процессы 1С (only_1c=true).
Отбор: 19968.

| PID | Запущен | Командная строка |
|-----|---------|------------------|
| 19968 | 15.10.2026 22:27:04 | "C:\\Program Files\\1cv8\\8.5.1.1423\\bin\\1cv8c.exe"  ENTERPRISE /S"localhost\\ui-demo" /TESTCLIENT -TPort 48000 /iTaxi /N"FixtureUser" |`);
