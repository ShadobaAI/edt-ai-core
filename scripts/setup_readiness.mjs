import fs from "node:fs";
import path from "node:path";
import { ROOT, load, stable, atomic_write, inside } from "./common.mjs";
import { exists, is_file, sha256, instance_directory, instance_name, reconnect_file, project_directory } from "./project_paths.mjs";
import { edt_connection } from "./directory_context.mjs";
import { setup_knowledge_status } from "./setup_probe.mjs";
import { knowledge_evidence_revision } from "./components.mjs";

const digest = file => is_file(file) ? sha256(fs.readFileSync(file)) : "missing";
const receipt_file = (state, root) => path.join(instance_directory(state, root), instance_name() + ".readiness.json");
const passed = item => ["ready", "disabled"].includes(item.state);

// Verify the installed workflow files, not whether a host/model has invoked a
// skill or trusted a hook. Those are separate from setup acceptance.
export function setup_assets(pluginRoot = ROOT) {
  const checks = [], files = new Set(["plugin.json", "mcp.json", "policy/default.json", "policy/read-only-mcp.mjs", "hooks/hooks.json", "hooks/guard.mjs", "hooks/session-start.mjs", "skills/catalog.yaml"]);
  try {
    const catalog = load(inside(pluginRoot, "skills/catalog.yaml"));
    if (!Array.isArray(catalog.active) || !catalog.active.length) throw new Error("Каталог навыков пуст.");
    for (const id of catalog.active) {
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Некорректное имя навыка.");
      const name = `skills/${id}/SKILL.md`, file = inside(pluginRoot, name);
      files.add(name);
      if (!is_file(file) || !fs.readFileSync(file, "utf8").trim()) throw new Error("Навык недоступен: " + id);
    }
    // Referenced workflow files are part of the checked installation too.
    const visit = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Ссылка в каталоге навыков.");
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file); else if (/\.(md|yaml)$/.test(entry.name)) files.add(path.relative(pluginRoot, file));
    } };
    visit(inside(pluginRoot, "skills"));
    checks.push({ id: "skills", label: "Навыки", state: "ready", detail: "Доступно навыков: " + catalog.active.length });
  } catch (error) { checks.push({ id: "skills", label: "Навыки", state: "error", detail: error.message }); }
  try {
    const hooks = load(inside(pluginRoot, "hooks/hooks.json"));
    for (const [event, script] of [["SessionStart", "session-start.mjs"], ["PreToolUse", "guard.mjs"]])
      if (!hooks.hooks?.[event]?.some(group => group.hooks?.some(hook => hook.type === "command" && hook.command?.includes(script)))) throw new Error("Не настроен обработчик события " + event);
    for (const name of files) if (!is_file(inside(pluginRoot, name))) throw new Error("Нет файла: " + name);
    checks.push({ id: "source-guard", label: "Файлы защиты и подключения плагина", state: "ready", detail: "Файлы защиты, политики и подключений доступны. Работу защиты при вызове инструментов в Codex эта проверка не подтверждает." });
  } catch (error) { checks.push({ id: "source-guard", label: "Файлы защиты и подключения плагина", state: "error", detail: error.message }); }
  checks.push({ id: "node", label: "Среда Node.js", state: Number(process.versions.node.split(".")[0]) >= 22 ? "ready" : "error", detail: process.version });
  return { checks, fingerprint: sha256(Buffer.from(stable([...files].sort().map(name => [name, digest(inside(pluginRoot, name))])))) };
}

export function readiness_fingerprint(state, config, profile, assets = setup_assets()) {
  return sha256(Buffer.from(stable({ root: config.active_project, instance: instance_name(), config, profile, assets: assets.fingerprint,
    runtime: digest(path.join(state, "runtime-lock.json")), edt: edt_connection(config.active_project), reconnect: digest(reconnect_file(state, config.active_project)),
    daemonOwner: digest(path.join(project_directory(state, config.active_project), "code-index/owner.json")),
    instructions: ["AGENTS.md", ".ai/PROJECT.md"].map(name => digest(inside(config.active_project, name))),
    knowledge: knowledge_evidence_revision(config, config.active_project, profile),
  })));
}

export function save_readiness(state, config, profile, managed, external) {
  const assets = setup_assets();
  const knowledge = setup_knowledge_status(profile, config, config.active_project, external.openviking);
  const checks = [{ id: "profile", label: "Профиль и проекты", state: profile.repositories.length ? "ready" : "error", detail: "Настроено проектов: " + profile.repositories.length },
    { id: "knowledge", label: "Режим знаний", state: knowledge.state === "disabled" ? "disabled" : knowledge.state === "ready" ? "ready" : knowledge.state === "invalid" ? "error" : "not_verified", detail: knowledge.detail },
    ...managed.map(item => ({ id: item.name, label: ({ "code-index": "Индекс кода", "bsl-ls": "BSL LS", policy: "Политика" })[item.name] || item.name, state: item.state === "disabled" ? "disabled" : item.ready ? "ready" : item.state || "error", detail: item.detail,
      ...(item.repositories ? { repositories: item.repositories } : {}) })),
    ...Object.entries(external).map(([id, item]) => ({ id, label: id === "edt" ? "EDT и готовность проектов" : id, state: item.ready ? "ready" : item.connected ? "not_verified" : "error", detail: item.detail || (!item.configured ? "Укажите адрес сервера в настройках подключений." : id === "edt" && item.projectReadiness !== "verified" ? "Не подтверждены точные пути, имена и готовность EDT-проектов." : "") })),
    ...assets.checks];
  const result = { state: checks.every(passed) ? "ready" : "blocked", checkedAt: new Date().toISOString(), checks, scope: "setup", knowledge,
    workflowReadiness: { state: "not_checked", scope: "workflow", detail: "Setup acceptance does not authorize a task or another session's knowledge dependency." } };
  result.expiresAt = new Date(Math.min(Date.parse(result.checkedAt) + 15 * 60 * 1000,
    knowledge.ready ? Date.parse(knowledge.readiness.expiresAt) : Infinity)).toISOString();
  atomic_write(receipt_file(state, config.active_project), JSON.stringify({ version: 2, fingerprint: readiness_fingerprint(state, config, profile, assets), result }));
  return result;
}

export async function read_readiness(state, config, profile) {
  const empty = { state: "not_checked", checks: [], scope: "setup" };
  if (!config.active_project || profile.status && profile.status !== "loaded") return empty;
  const file = receipt_file(state, config.active_project);
  if (!exists(file)) return empty;
  try {
    const receipt = JSON.parse(fs.readFileSync(file, "utf8")), result = receipt.result;
    if (receipt.version !== 2 || result?.scope !== "setup" || !Number.isFinite(Date.parse(result.expiresAt)) || !Array.isArray(result?.checks) || !result.checks.length || !["ready", "blocked"].includes(result.state) || result.checks.some(item => !item || typeof item.id !== "string" || typeof item.label !== "string" || typeof item.state !== "string") || (result.state === "ready") !== result.checks.every(passed)) return empty;
    const age = Date.now() - Date.parse(result.checkedAt);
    const data = profile.status ? load(profile.path) : profile;
    if (!Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000 || Date.now() >= Date.parse(result.expiresAt) || receipt.fingerprint !== readiness_fingerprint(state, config, data))
      return { ...result, state: "stale", reason: "Настройки или файлы изменились либо проверка устарела. Повторите проверку готовности." };
    if (result.state === "ready" && config.mcp.managed["code-index"].enabled !== false && config.mcp.managed["code-index"].mode !== "external") {
      const { daemon_health, project_home } = await import("./runtime.mjs");
      if (!await daemon_health(path.join(project_home(state, config.active_project), "code-index"))) return { ...result, state: "stale", reason: "Сервис индекса остановлен. Повторите проверку готовности." };
    }
    return result;
  } catch { return empty; }
}
