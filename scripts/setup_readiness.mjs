import fs from "node:fs";
import path from "node:path";
import { ROOT, load, stable, atomic_write, inside } from "./common.mjs";
import { exists, is_file, sha256, instance_directory, instance_name, reconnect_file, project_directory } from "./project_paths.mjs";
import { edt_connection, repository_projects } from "./directory_context.mjs";
import { setup_knowledge_status, edt_project_building } from "./setup_probe.mjs";
import { knowledge_evidence_revision } from "./components.mjs";
import { verification_limits, sanitize_setup_result, register_diagnostic_secrets } from "./diagnostics.mjs";
import { project_profile } from "./profile.mjs";
import { which } from "./processes.mjs";

const digest = file => is_file(file) ? sha256(fs.readFileSync(file)) : "missing";
const receipt_file = (state, root) => path.join(instance_directory(state, root), instance_name() + ".readiness.json");
const local_bsl = config => config.mcp.managed["bsl-ls"].mode !== "external";

// Local API compatibility survives time passing and unrelated project changes.
// Inspect launch inputs without executing Java or starting the language server.
export function bsl_readiness_fingerprint(state, config) {
  const options = config.mcp.managed["bsl-ls"];
  const fileDigest = file => { try { return digest(file); } catch { return "unavailable"; } };
  const executable = command => { try { const file = which(command); return file ? [fs.realpathSync.native(file), fileDigest(file)] : null; } catch { return "unavailable"; } };
  let runtime = null;
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(state, "runtime-lock.json"), "utf8"))["bsl-ls"];
    if (entry) { const { candidate, previous, ...active } = entry; runtime = active; }
  } catch {}
  let jar = "missing";
  try { if (runtime?.path) jar = digest(inside(state, runtime.path)); } catch { jar = "invalid"; }
  let configuration = null;
  try { if (options.configuration) configuration = fileDigest(path.isAbsolute(options.configuration) ? options.configuration : inside(config.active_project, options.configuration)); }
  catch { configuration = "invalid"; }
  return sha256(stable({ root: config.active_project, instance: instance_name(), options, runtime, jar,
    java: executable(options.java || "java"), node: executable(options.node || process.execPath),
    configuration,
    javaOptions: ["JAVA_HOME", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"].map(name => process.env[name] || null),
    adapter: fileDigest(inside(ROOT, "mcp/bsl-ls-proxy.mjs")) }));
}

function component_record(state, config, check, checkedAt, fingerprint) {
  const { name, ready, ...result } = check;
  const durable = check.id === "bsl-ls" && local_bsl(config) && ["ready", "error"].includes(check.state);
  const observedAt = check.checkedAt || checkedAt;
  const inputRevision = durable ? check.inputRevision || bsl_readiness_fingerprint(state, config) : null;
  return { fingerprint: inputRevision || fingerprint, result: sanitize_setup_result({ ...result, checkedAt: observedAt,
    ...(durable ? { validity: "inputs", inputRevision, expiresAt: null } : {
      expiresAt: new Date(Math.min(Date.parse(observedAt) + 15 * 60 * 1000, Number.isFinite(Date.parse(check.expiresAt)) ? Date.parse(check.expiresAt) : Infinity)).toISOString() }) }) };
}
export const readiness_receipt_revision = (state, root) => digest(receipt_file(state, root));
function passed(item, profile) {
  if (item.state === "ready") return true;
  if (item.state !== "disabled") return false;
  const authority = { "code-index": "code_index", "bsl-ls": "bsl_ls" }[item.id];
  return !authority || profile.authorities?.[authority] !== item.id;
}

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

export function readiness_fingerprint(state, config, profile, assets = setup_assets(), { includeDaemonOwner = true } = {}) {
  return sha256(Buffer.from(stable({ root: config.active_project, instance: instance_name(), config, profile, assets: assets.fingerprint,
    runtime: digest(path.join(state, "runtime-lock.json")), edt: edt_connection(config.active_project), descriptors: repository_projects(config.active_project, profile.repositories), reconnect: digest(reconnect_file(state, config.active_project)),
    ...(includeDaemonOwner ? { daemonOwner: digest(path.join(project_directory(state, config.active_project), "code-index/owner.json")) } : {}),
    instructions: ["AGENTS.md", ".ai/PROJECT.md"].map(name => digest(inside(config.active_project, name))),
    knowledge: knowledge_evidence_revision(config, config.active_project, profile, state),
  })));
}

export function save_readiness(state, config, profile, managed, external) {
  register_diagnostic_secrets(config);
  const assets = setup_assets();
  const knowledge = setup_knowledge_status(profile, config, config.active_project, external.openviking, state);
  const checks = [{ id: "profile", label: "Профиль и проекты", state: profile.repositories.length ? "ready" : "error", detail: "Настроено проектов: " + profile.repositories.length },
    { id: "knowledge", label: "Режим знаний", state: knowledge.state === "disabled" ? "disabled" : knowledge.state === "ready" ? "ready" : knowledge.state === "invalid" ? "error" : "not_verified", detail: knowledge.detail },
    ...managed.map(item => ({ id: item.name, label: ({ "code-index": "Индекс кода", "bsl-ls": "BSL LS", policy: "Политика" })[item.name] || item.name, state: item.state === "disabled" ? "disabled" : item.ready ? "ready" : item.state || "error", detail: item.detail,
      ...(item.repositories ? { repositories: item.repositories } : {}) })),
    ...Object.entries(external).map(([id, item]) => ({ id, label: id === "edt" ? "EDT и готовность проектов" : id, state: item.ready ? "ready" : id === "edt" && edt_project_building(item) ? "building" : item.connected ? "not_verified" : "error", ...(item.failure ? { failure: item.failure } : {}), detail: item.detail || (!item.configured ? "Укажите адрес сервера в настройках подключений." : id === "edt" && item.projectReadiness !== "verified" ? "Не подтверждены точные пути, имена и готовность EDT-проектов." : "") })),
    ...assets.checks];
  const result = { state: checks.every(item => passed(item, profile)) ? "ready" : "blocked", checkedAt: new Date().toISOString(), checks, scope: "setup", knowledge,
    verificationLimits: verification_limits(knowledge.ready),
    workflowReadiness: { state: "not_checked", scope: "workflow", detail: "Проверка настройки не разрешает действия задачи и не подтверждает знания другой сессии." } };
  result.expiresAt = new Date(Math.min(Date.parse(result.checkedAt) + 15 * 60 * 1000,
    knowledge.ready ? Date.parse(knowledge.readiness.expiresAt) : Infinity)).toISOString();
  const safe = sanitize_setup_result(result);
  const components = component_receipt(state, config.active_project).components || {};
  for (const id of [...managed.map(item => item.name), ...Object.keys(external)]) delete components[id];
  const bsl = managed.find(item => item.name === "bsl-ls");
  if (bsl && local_bsl(config) && ["ready", "error"].includes(bsl.state))
    components["bsl-ls"] = component_record(state, config, { ...bsl, id: "bsl-ls" }, safe.checkedAt);
  atomic_write(receipt_file(state, config.active_project), JSON.stringify({ version: 3, fingerprint: readiness_fingerprint(state, config, profile, assets), result: safe, components }));
  return safe;
}

function component_receipt(state, root) {
  try {
    const receipt = JSON.parse(fs.readFileSync(receipt_file(state, root), "utf8"));
    if (receipt?.version !== 3) return {};
    if (!receipt.components || typeof receipt.components !== "object" || Array.isArray(receipt.components)) receipt.components = {};
    return receipt;
  }
  catch { return {}; }
}

// Addressed observations share the setup receipt and its project/instance and
// expiry rules, except local BSL LS compatibility which expires on input changes.
// Partial checks never turn into full setup acceptance.
export function save_component_checks(state, config, profile, checks) {
  register_diagnostic_secrets(config);
  const receipt = component_receipt(state, config.active_project), checkedAt = new Date().toISOString();
  const fingerprint = readiness_fingerprint(state, config, profile);
  receipt.version = 3; receipt.components ||= {};
  for (const check of checks) {
    if (check.id === "bsl-ls" && local_bsl(config) && check.validity === "inputs" && check.state === "check_stale") continue;
    receipt.components[check.id] = component_record(state, config, check, checkedAt, fingerprint);
  }
  atomic_write(receipt_file(state, config.active_project), JSON.stringify(receipt));
  return checks.map(check => check.id === "bsl-ls" && local_bsl(config) && check.validity === "inputs" && check.state === "check_stale"
    ? sanitize_setup_result(check) : receipt.components[check.id].result);
}

export function read_component_checks(state, config, profile) {
  if (!config.active_project || profile.status && profile.status !== "loaded") return [];
  const entries = Object.values(component_receipt(state, config.active_project).components || {});
  if (!entries.length) return [];
  const fingerprint = readiness_fingerprint(state, config, profile.status ? project_profile(config.active_project) : profile);
  const bslFingerprint = entries.some(entry => entry?.result?.id === "bsl-ls" && entry.result.validity === "inputs") && local_bsl(config)
    ? bsl_readiness_fingerprint(state, config) : null;
  return entries.flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const { fingerprint: saved, result } = entry;
    if (!result || typeof result.id !== "string" || typeof result.state !== "string" || !Number.isFinite(Date.parse(result.checkedAt))) return [];
    if (result.id === "bsl-ls" && result.validity === "inputs" && bslFingerprint) {
      const invalid = saved !== bslFingerprint || Date.now() < Date.parse(result.checkedAt);
      return [{ ...result, expiresAt: null, inputRevision: bslFingerprint, ...(invalid ? { state: "check_stale", lastState: result.state,
        detail: "Окружение или настройки BSL LS изменились. Повторите «Подготовить и проверить»." } : {}) }];
    }
    if (!Number.isFinite(Date.parse(result.expiresAt))) return [];
    return [{ ...result, ...(saved !== fingerprint || Date.now() < Date.parse(result.checkedAt) || Date.now() - Date.parse(result.checkedAt) > 15 * 60 * 1000 || Date.now() >= Date.parse(result.expiresAt)
      ? { state: "check_stale", lastState: result.lastState || result.state, detail: saved === fingerprint && result.state === "check_stale" && result.detail ? result.detail : "Настройки или файлы изменились либо проверка устарела. Повторите проверку компонента." } : {}) }];
  });
}

export async function read_readiness(state, config, profile) {
  const empty = { state: "not_checked", checks: [], scope: "setup", verificationLimits: verification_limits() };
  if (!config.active_project || profile.status && profile.status !== "loaded") return empty;
  const file = receipt_file(state, config.active_project);
  if (!exists(file)) return empty;
  try {
    const receipt = JSON.parse(fs.readFileSync(file, "utf8")), result = receipt.result;
    if (receipt.version !== 3) return { ...empty, reason: "Несовместимая версия readiness-подтверждения. Повторите setup-проверку; старые диагностические данные не загружаются." };
    if (result?.scope !== "setup" || !Number.isFinite(Date.parse(result.expiresAt)) || !Array.isArray(result?.checks) || !result.checks.length || !["ready", "blocked"].includes(result.state) || result.checks.some(item => !item || typeof item.id !== "string" || typeof item.label !== "string" || typeof item.state !== "string")) return empty;
    const age = Date.now() - Date.parse(result.checkedAt);
    const data = profile.status ? project_profile(config.active_project) : profile;
    if (!Number.isFinite(age) || age < 0 || typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint))
      return { ...empty, reason: "Не удалось подтвердить сохранённую проверку готовности. Повторите проверку." };
    if (age > 15 * 60 * 1000 || Date.now() >= Date.parse(result.expiresAt) || receipt.fingerprint !== readiness_fingerprint(state, config, data))
      return { ...result, state: "stale", verificationLimits: verification_limits(), reason: "Настройки или файлы изменились либо проверка устарела. Повторите проверку готовности." };
    if ((result.state === "ready") !== result.checks.every(item => passed(item, data)))
      return { ...empty, reason: "Сохранённый результат не соответствует обязательным компонентам. Повторите проверку готовности." };
    return { ...result, verificationLimits: verification_limits(result.knowledge?.ready === true) };
  } catch { return empty; }
}
