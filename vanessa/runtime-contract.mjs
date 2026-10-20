// Verified wire format: Vanessa Automation Single 1.2.043.45 / MCP 1.31.
// Patterns come from live get_environment_data, get_vanessa_automation_state,
// manage_test_client_profiles and get_editor_state responses captured 2026-10-15.
export function toolText(result) {
  if (result?.isError || !Array.isArray(result?.content) || result.content.some(item => item.type !== "text" || typeof item.text !== "string")) return null;
  return result.content.map(item => item.text).join("\n").replace(/\r\n/g, "\n");
}
export function toolMessage(result) {
  const text = toolText(result);
  if (!text) return null;
  if (!text.trimStart().startsWith("{")) return text;
  try {
    const envelope = JSON.parse(text);
    return envelope && typeof envelope.message === "string" && typeof envelope.completedAt === "string" &&
      Object.keys(envelope).every(key => ["message", "completedAt"].includes(key)) ? envelope.message : null;
  } catch { return null; }
}
function scalar(text, key) {
  const prefix = `- ${key}: `;
  const matches = text.split("\n").filter(line => line.startsWith(prefix));
  return matches.length === 1 ? matches[0].slice(prefix.length).trim() : null;
}
function yesNo(value) { return value?.toLowerCase() === "да" ? true : value?.toLowerCase() === "нет" ? false : null; }

export function parseInfobase(value) {
  if (typeof value !== "string") return null;
  const fields = {}, pattern = /\s*([a-z][a-z0-9]*)\s*=\s*(?:"((?:[^"]|"")*)"|([^;]*))\s*;/igy;
  let offset = 0, match;
  while (offset < value.length) {
    pattern.lastIndex = offset; match = pattern.exec(value);
    if (!match || Object.hasOwn(fields, match[1].toLowerCase())) return null;
    fields[match[1].toLowerCase()] = (match[2] ?? match[3]).replaceAll('""', '"').trim(); offset = pattern.lastIndex;
  }
  if (fields.file && !fields.srvr && !fields.ref) return { type: "file", path: fields.file };
  if (fields.srvr && fields.ref && !fields.file) return { type: "server", server: fields.srvr, database: fields.ref };
  return null;
}
export function parseEnvironment(result) {
  const text = toolText(result);
  if (!text?.startsWith("# Данные об окружении\n") || !text.includes("\n- Это Vanessa Automation Single\n")) return null;
  const runtimeVersion = scalar(text, "Версия")?.replace(/^ver /, "");
  const mcpVersion = scalar(text, "Версия MCP");
  const managerInfobase = parseInfobase(scalar(text, "Строка соединения с информационной базой"));
  const vanessaExt = yesNo(scalar(text, "Включено использование внешней компоненты VanessaExt"));
  if (runtimeVersion !== "1.2.043.45" || mcpVersion !== "1.31" || !managerInfobase || vanessaExt === null) return null;
  return { runtimeVersion, mcpVersion, platformVersion: scalar(text, "Платформа") ?? null, managerInfobase, vanessaExt };
}
export function parseState(result) {
  const text = toolText(result);
  if (!text?.startsWith("# Состояние Vanessa Automation\n")) return null;
  const running = yesNo(scalar(text, "Выполнение сценариев"));
  const connected = yesNo(scalar(text, "Клиент тестирования подключен"));
  const recording = yesNo(scalar(text, "Включена запись действий пользователя"));
  if ([running, connected, recording].some(value => value === null)) return null;
  const names = [...text.matchAll(/^  - Имя профиля клиента тестирования: (.+)$/gm)];
  if (connected && names.length !== 1) return null;
  return { running, connected, recording, ...(connected ? { clientName: names[0][1] } : {}) };
}
export function parseEditor(result) {
  const text = toolText(result);
  if (!text?.startsWith("# Состояние редактора\n")) return null;
  const tabs = [...text.matchAll(/^## Открытые вкладки\nКоличество: (\d+)$/gm)];
  const errors = [...text.matchAll(/^## Ошибки в редакторе\nКоличество: (\d+)$/gm)];
  if (tabs.length !== 1 || errors.length !== 1 || !text.includes("\n## Активный документ\n")) return null;
  // This may be a cached snapshot after the editor has been disabled. It proves
  // readable state, never the live enabled flag; open_feature_file proves that.
  return { stateAvailable: true, tabCount: Number(tabs[0][1]), errorCount: Number(errors[0][1]) };
}
export function parseSyntax(result) {
  const text = toolMessage(result);
  if (!text?.startsWith("# Проверка синтаксиса Gherkin\n")) return null;
  const file = scalar(text, "Файл"), valid = yesNo(scalar(text, "Синтаксис корректен"));
  const count = scalar(text, "Количество проблем");
  if (!file || valid === null || !/^\d+$/.test(count ?? "")) return null;
  return { file, valid: valid && Number(count) === 0, problemCount: Number(count) };
}
export function parseSelection(result, editorResult) {
  if (toolMessage(result)?.trim() !== "Сценарий сделан текущим. Теперь при выполнении текущего сценария будет выполнен этот сценарий.") return null;
  const editor = parseEditor(editorResult), text = toolText(editorResult)?.split("\n### Содержимое\n")[0];
  if (!editor || !text || editor.errorCount !== 0) return null;
  const files = [...text.matchAll(/^- \*\*→\*\* (.+)$/gm)], names = [...text.matchAll(/^### Выбранный сценарий: (.+)$/gm)];
  if (files.length !== 1 || names.length !== 1) return null;
  const section = text.split("### Все сценарии из файла:\n");
  if (section.length !== 2) return null;
  const scenarios = [...section[1].split(/^##/m)[0].matchAll(/^- (.+)$/gm)].map(match => match[1]);
  return { file: files[0][1], scenario: names[0][1], occurrences: scenarios.filter(name => name === names[0][1]).length };
}
export function editorContent(result) {
  const text = toolText(result);
  if (!text) return null;
  const fences = [...text.matchAll(/^```[^\n]*$/gm)];
  if (fences.length !== 2 || fences[0][0] !== "```gherkin" || fences[1][0] !== "```" ||
      !text.slice(0, fences[0].index).endsWith("### Содержимое\n") || text[fences[1].index - 1] !== "\n") return null;
  // The response adds one newline before its closing delimiter. Preserve every
  // newline/space belonging to the document, including leading/trailing blanks.
  return text.slice(fences[0].index + fences[0][0].length + 1, fences[1].index - 1);
}
export const normalizeFeatureText = text => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
function propertyTable(text) {
  const result = {};
  for (const line of text.split("\n")) {
    const row = /^\| ([^|]+) \| (.*?) \|$/.exec(line);
    if (!row || row[1] === "Свойство") continue;
    const key = row[1].trim();
    if (Object.hasOwn(result, key)) return null;
    result[key] = row[2].trim();
  }
  return result;
}
export function parseProfiles(result) {
  const text = toolText(result);
  if (!text?.startsWith("# Список профилей клиентов тестирования\n")) return null;
  const count = /^Найдено профилей: (\d+)$/m.exec(text);
  if (!count) return null;
  const sections = [...text.matchAll(/^## Профиль: (.+)\n([\s\S]*?)(?=^## Профиль: |$(?![\s\S]))/gm)];
  if (sections.length !== Number(count[1])) return null;
  const profiles = [];
  for (const section of sections) {
    const fields = propertyTable(section[2]);
    if (!fields || fields["Имя"] !== section[1] || typeof fields["Дополнительные параметры"] !== "string") return null;
    const infobase = parseInfobase(fields["Строка подключения"]);
    if (!infobase) return null;
    profiles.push({ name: section[1], infobase, additionalParameters: fields["Дополнительные параметры"],
      connected: fields["Статус"] === "❌ не подключен" ? false : fields["Статус"] === "✅ подключен" ? true : null,
      computerName: fields["Имя компьютера"], pid: /^\d+$/.test(fields.PID ?? "") ? Number(fields.PID) : null });
  }
  return profiles;
}
export function parseExtensions(result) {
  const text = toolText(result);
  if (!text?.startsWith("# Список расширений, установленных в базе\n")) return null;
  const count = /^## Итого: (\d+) расширений$/m.exec(text);
  if (!count) return null;
  const sections = [...text.matchAll(/^## (\d+)\. (.+)\n([\s\S]*?)(?=^## (?:\d+\. |Итого: )|$(?![\s\S]))/gm)];
  if (sections.length !== Number(count[1])) return null;
  const extensions = [];
  for (const [index, section] of sections.entries()) {
    const fields = propertyTable(section[3]);
    const active = yesNo(fields?.["Активно"]);
    if (Number(section[1]) !== index + 1 || !fields || fields["Имя"] !== section[2] || !fields["Версия"] || active === null) return null;
    extensions.push({ name: fields["Имя"], version: fields["Версия"], active });
  }
  return extensions;
}
export function platformTokens(command) {
  if (typeof command !== "string") return null;
  const tokens = []; let token = "", quoted = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '"') {
      if (quoted && command[i + 1] === '"') { token += '"'; i++; } else quoted = !quoted;
    } else if (/\s/.test(char) && !quoted) { if (token) tokens.push(token); token = ""; } else token += char;
  }
  if (quoted) return null;
  if (token) tokens.push(token);
  return tokens;
}
export function parseClientLaunch(command) {
  const tokens = platformTokens(command);
  if (!tokens || !/(?:^|[\\/])1cv8c?\.exe$/i.test(tokens[0] ?? "") || !tokens.some(token => /^\/TESTCLIENT$/i.test(token))) return null;
  if (!tokens.some(token => /^\/iTaxi$/i.test(token)) || tokens.some(token => /^\/itdi$/i.test(token))) return null;
  const bases = [], users = [], ports = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\/IBConnectionString$/i.test(token)) bases.push(parseInfobase(tokens[++i]));
    else if (/^\/S/i.test(token) && (token.length === 2 || token.slice(2).includes("\\"))) {
      const value = token.length === 2 ? tokens[++i] : token.slice(2), split = value?.lastIndexOf("\\") ?? -1;
      bases.push(split > 0 && split < value.length - 1 ? { type: "server", server: value.slice(0, split), database: value.slice(split + 1) } : null);
    } else if (/^\/F/i.test(token)) bases.push({ type: "file", path: token.length === 2 ? tokens[++i] : token.slice(2) });
    else if (/^\/N/i.test(token)) users.push(token.length === 2 ? tokens[++i] : token.slice(2));
    else if (/^-TPort$/i.test(token)) ports.push(Number(tokens[++i]));
  }
  if (bases.length !== 1 || !bases[0] || users.length > 1 || ports.length !== 1 || !Number.isInteger(ports[0]) || ports[0] < 1 || ports[0] > 65535) return null;
  return { infobase: bases[0], user: users[0] ?? null, testPort: ports[0], interface: "taxi" };
}
export function parseProcesses(result) {
  const text = toolText(result);
  if (!text?.startsWith("# Список процессов ОС\n") || !text.includes("Режим: только процессы 1С (only_1c=true).")) return null;
  const count = /^Найдено по отбору: (\d+) из (\d+)\. Показано: (\d+)\.$/m.exec(text);
  const filter = /^Отбор: (.+)\.$/m.exec(text)?.[1];
  if (!count || !filter || Number(count[1]) !== Number(count[3])) return null;
  const rows = [...text.matchAll(/^\| (\d+) \| (.*?) \| (.*?) \|$/gm)];
  if (rows.length !== Number(count[3]) || new Set(rows.map(row => row[1])).size !== rows.length) return null;
  return { filter, matchedCount: Number(count[1]), processes: rows.map(row => ({ pid: Number(row[1]), startedAt: row[2], launch: parseClientLaunch(row[3]) })) };
}
export const runtimeContract = Object.freeze({ version: "vanessa-single-1.2.043.45-mcp-1.31", environment: parseEnvironment,
  state: parseState, profiles: parseProfiles, editor: parseEditor, extensions: parseExtensions, processes: parseProcesses,
  syntax: parseSyntax, selection: parseSelection, editorContent });
