import fs from "node:fs";
import path from "node:path";
import { atomic_write } from "./common.mjs";
import { resolve } from "./project_paths.mjs";

const filename = "1c-ai-core-settings.json";
const state_exports = {
  settings: { directories: ["exports"], filename },
  diagnostics: { directories: ["diagnostics", "exports"], filename: "1c-ai-core-diagnostics.json" },
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
  if (typeof data?.text !== "string" || Buffer.byteLength(data.text) > limit)
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
  atomic_write(file, data.text, exists);
  if (fs.readFileSync(file, "utf8") !== data.text) throw new Error("Не удалось подтвердить сохранение файла.");
  return { filename: name, path: file, directory, bytes: Buffer.byteLength(data.text) };
}
function export_directory(state) {
  const directory = path.resolve(state, "exports");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Каталог экспорта настроек недоступен.");
  return directory;
}
export function saved_settings_export(state) {
  try {
    const directory = export_directory(state), file = path.join(directory, filename), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { filename, path: file, directory, bytes: stat.size };
  } catch { return null; }
}
// Keep the helper name for existing callers, but require an explicit target.
export function save_settings_export(state, data, destination) {
  if (!destination) throw new Error("Выберите место сохранения файла настроек.");
  return save_export_to_path(destination, data);
}
