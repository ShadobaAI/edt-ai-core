import fs from "node:fs";
import path from "node:path";
import { atomic_write } from "./common.mjs";
import { resolve } from "./project_paths.mjs";

const state_exports = {
  diagnostics: { directories: ["diagnostics", "exports"], filename: "1c-ai-core-diagnostics.json" },
  logs: { directories: ["diagnostics", "exports"], filename: "1c-ai-core-log.txt" },
  project_profile: { directories: ["exports"], filename: "project.yaml" },
  project_local: { directories: ["exports"], filename: "project.local.yaml" },
  project_both: { directories: ["exports"], filename: "1c-ai-core-project.zip" },
};
export function state_export_path(state, kind) {
  if (typeof state !== "string" || !state || !Object.hasOwn(state_exports, kind)) throw new Error("Некорректное назначение экспорта.");
  const target = state_exports[kind];
  return path.join(resolve(state), ...target.directories, target.filename);
}
// The non-Windows fallback uses fixed names in private state. Reject links in
// the created subdirectories and recheck the destination after boundary checks.
export function save_state_export(state, kind, data, expectedFile, limit) {
  const file = state_export_path(state, kind);
  if (file !== expectedFile) throw new Error("Каталог экспорта изменился. Повторите сохранение.");
  let directory = resolve(state);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const part of state_exports[kind].directories) {
    directory = path.join(directory, part);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Каталог экспорта недоступен или является ссылкой.");
  }
  return save_export_to_path(file, data, limit);
}
// Callers supply the chosen destination. Reject links and verify the actual
// bytes; the app handles cancellation before calling this function.
export function save_export_to_path(file, data, limit = 2 * 1024 * 1024) {
  let content;
  if (typeof data?.text === "string") content = Buffer.from(data.text, "utf8");
  else if (typeof data?.base64 === "string" && data.base64.length <= Math.ceil(limit / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.base64)) content = Buffer.from(data.base64, "base64");
  if (!content || content.length > limit)
    throw new Error("Файл отсутствует или превышает допустимый размер.");
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Выберите абсолютный путь к файлу.");
  const directory = path.dirname(file), name = path.basename(file);
  if (!name || !fs.statSync(directory).isDirectory()) throw new Error("Каталог сохранения недоступен.");
  let exists = false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Назначение должно быть обычным файлом, не ссылкой.");
    exists = true;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  atomic_write(file, content, exists);
  if (!fs.readFileSync(file).equals(content)) throw new Error("Не удалось подтвердить сохранение файла.");
  return { filename: name, path: file, directory, bytes: content.length };
}
