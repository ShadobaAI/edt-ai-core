import { withHttpMcp } from "../mcp/http-client.mjs";
import { loadManagerProfile } from "../vanessa/profile.mjs";
import { listTools, callTool } from "../vanessa/mcp.mjs";
import { runtimeContract } from "../vanessa/runtime-contract.mjs";
import { sameInfobase } from "../vanessa/readiness.mjs";
import fs from "node:fs";
import path from "node:path";
import { inside } from "./common.mjs";
import { resolve } from "./project_paths.mjs";

function matchesFileBaseSnapshot(file, snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !path.isAbsolute(file || "")) return false;
  try {
    const actual = fs.realpathSync.native(file), stat = fs.statSync(actual);
    return stat.isDirectory() && actual === snapshot.path && stat.dev === snapshot.device && stat.ino === snapshot.inode;
  } catch { return false; }
}

// This observes only the configured manager. It neither launches 1C nor needs
// a connected TestClient, an idle manager, or platform-specific process APIs.
export async function probe_vanessa(root, project, { runtimeSnapshot } = {}) {
  const result = await inspect_manager(root, project, runtimeSnapshot);
  // A combined refresh can wait much longer for unrelated components.
  // Start the manager evidence lifetime when this check actually finishes.
  return { ...result, checkedAt: new Date().toISOString() };
}

async function inspect_manager(root, project, runtimeSnapshot) {
  const id = "vanessa";
  if (!project.testing.vanessa) return { id, state: "disabled", detail: "Возможность отключена в профиле." };
  if (!project.testing.vanessa_config) return { id, state: "missing_config", detail: "В профиле отсутствует блок testing.vanessa_config." };
  if (runtimeSnapshot === "missing") return { id, state: "missing_config", detail: "Не найден runtime-профиль Vanessa. Проверьте путь в настройках проекта." };
  if (runtimeSnapshot !== undefined && (!runtimeSnapshot || typeof runtimeSnapshot !== "object"))
    return { id, state: "not_verified", detail: "Не удалось прочитать runtime-профиль Vanessa. Проверьте файл и права доступа." };
  let profile;
  try {
    const file = inside(root, project.testing.vanessa_config.runtime_profile);
    if (runtimeSnapshot !== undefined && (!runtimeSnapshot || typeof runtimeSnapshot !== "object" || resolve(file) !== runtimeSnapshot.file))
      throw new Error("Runtime-профиль изменился во время проверки");
    profile = loadManagerProfile(file, runtimeSnapshot?.digest);
    if (resolve(profile.projectRoot) !== resolve(root) || profile.mcp.serverName !== project.testing.vanessa_config.server_name)
      throw new Error("Неверная привязка проекта или сервера");
  } catch (error) {
    const detail = error?.code === "ENOENT"
      ? "Не найден runtime-профиль Vanessa. Проверьте путь в настройках проекта."
      : ["EACCES", "EPERM"].includes(error?.code)
        ? "Нет доступа к runtime-профилю Vanessa. Проверьте права на файл."
        : error?.message === "Неверная привязка проекта или сервера"
          ? "Проект или имя сервера в runtime-профиле Vanessa не совпадают с настройками профиля."
          : "Не удалось проверить параметры менеджера: формат runtime-профиля или его содержимое некорректны.";
    return { id, state: "missing_config", detail };
  }
  let received = false;
  try {
    return await withHttpMcp({ url: profile.mcp.url }, async client => {
      const tools = await listTools(client);
      if (!tools.some(tool => tool.name === "get_environment_data"))
        return { id, state: "not_verified", detail: "MCP отвечает, но не предоставляет проверку окружения Vanessa." };
      const environment = runtimeContract.environment(await callTool(client, tools, "get_environment_data", {}));
      if (!environment)
        return { id, state: "not_verified", detail: "MCP отвечает, но данные менеджера Vanessa не удалось подтвердить." };
      const fileBases = profile.manager.infobase.type === "file" && environment.managerInfobase?.type === "file";
      const matches = fileBases && runtimeSnapshot !== undefined
        ? matchesFileBaseSnapshot(profile.manager.infobase.path, runtimeSnapshot.managerBase) && matchesFileBaseSnapshot(environment.managerInfobase.path, runtimeSnapshot.managerBase)
        : sameInfobase(profile.manager.infobase, environment.managerInfobase);
      if (!matches) {
        // A file base can be compared only when both canonical paths are accessible.
        if (profile.manager.infobase.type === "file" && environment.managerInfobase.type === "file")
          return { id, state: "not_verified", detail: "MCP отвечает, но совпадение файловой информационной базы не подтверждено." };
        if (profile.manager.infobase.type === "server" && environment.managerInfobase.type === "server" &&
            profile.manager.infobase.database.toLowerCase() === environment.managerInfobase.database.toLowerCase())
          return { id, state: "not_verified", detail: "MCP отвечает, но имена серверов информационной базы различаются. Их соответствие не подтверждено." };
        return { id, state: "mismatch", detail: "MCP отвечает, но информационная база менеджера отличается от runtime-профиля." };
      }
      return { id, state: "ready", detail: "MCP менеджера отвечает; информационная база совпадает. Настройки запуска, TestClient и выполнение тестов не проверялись." +
        (environment.vanessaExt ? "" : " В менеджере не включена VanessaExt.") };
    }, { timeout: 10000, maxBytes: 1024 * 1024, onResponse: () => { received = true; } });
  } catch (error) {
    // Never expose upstream response text or connection details in settings.
    if (/Истекло время сессии HTTP MCP/.test(error?.message || ""))
      return { id, state: "error", detail: "Проверка MCP менеджера Vanessa превысила время ожидания (10 секунд)." };
    return received
      ? { id, state: "not_verified", detail: "По адресу менеджера получен ответ, но доступность MCP Vanessa не подтверждена. Проверьте настройки и журнал менеджера." }
      : { id, state: "stopped", detail: "Нет подключения к MCP менеджера Vanessa. Проверьте, что менеджер запущен и адрес в runtime-профиле верен." };
  }
}
