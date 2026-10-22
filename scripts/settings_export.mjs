import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const filename = "1c-ai-core-settings.json";
function export_directory(state, create = false) {
  const directory = path.resolve(state, "exports");
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
// Embedded webviews may block browser downloads. Confirm a real disk write
// before telling the app that its portable settings file has been saved.
export function save_settings_export(state, data) {
  if (typeof data?.text !== "string" || Buffer.byteLength(data.text) > 2 * 1024 * 1024)
    throw new Error("Файл настроек отсутствует или превышает 2 МиБ.");
  const directory = export_directory(state, true), file = path.join(directory, filename), temporary = path.join(directory, `.settings-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, data.text, { flag: "wx", mode: 0o600 });
    // Rename replaces the directory entry, without following an existing link.
    fs.renameSync(temporary, file);
    const saved = saved_settings_export(state);
    if (!saved || saved.bytes !== Buffer.byteLength(data.text)) throw new Error("Не удалось подтвердить сохранение настроек.");
    return saved;
  } finally { fs.rmSync(temporary, { force: true }); }
}
