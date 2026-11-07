import { RemoteMcp } from "./remote_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import { resolve } from "./project_paths.mjs";
import { knowledge_status } from "./knowledge.mjs";
import { OpenVikingAdapter } from "./openviking_adapter.mjs";
import { stable } from "./common.mjs";
import { knowledge_evidence_revision } from "./components.mjs";
import { connection_failure, verification_limits, safe_error_message, register_diagnostic_secrets, sanitize_diagnostics } from "./diagnostics.mjs";
import { repository_projects } from "./directory_context.mjs";
import { probe_yaxunit, yaxunit_result, yaxunit_unchecked } from "./yaxunit_readiness.mjs";
import { normalize_projects, match_edt_projects } from "./edt_launch_adapter.mjs";

const observations = new WeakMap();
export const edt_project_building = item => item.connected === true && item.repositories?.some(repo => repo.matched === true && repo.open === true && repo.ready !== true && repo.state === "building");
function edt_project_detail(repositories) {
  const lines = repositories.map(item => {
    let status = "готов";
    if (!item.matched) status = "имя и путь не сопоставлены с проектом EDT";
    else if (!item.required && item.open === false) status = "необязательный проект закрыт; недоступен для операций, требования EDT выполнены";
    else if (item.open !== true) status = "проект не открыт или его состояние открытия не подтверждено";
    else if (item.state === "building") status = "EDT сообщает о сборке проекта";
    else if (!item.ready) status = "готовность проекта EDT не подтверждена";
    return item.id + ": " + status;
  });
  if (repositories.some(item => item.matched && item.open === true && item.state === "building"))
    lines.push("Дождитесь завершения сборки в EDT и повторите проверку готовности. Если сборка не завершается, проверьте операции и ошибки в EDT.");
  if (repositories.length && !repositories.some(item => item.required))
    lines.push("Для готовности EDT нужен хотя бы один обязательный открытый и готовый проект; задайте edt_required: true в YAML.");
  return lines.join("\n");
}
function apply_edt_projects(result, root, profile, projects) {
  const unbound = new Set(profile.policy.unbound_edt_repositories || []);
  const candidates = repository_projects(root, profile.repositories.filter(repository => !unbound.has(repository.id)));
  const configured = candidates.filter(({ repository, projects }) => projects.length || repository.edt_project || (profile.policy.edt_repository_ids || []).includes(repository.id));
  result.repositories = match_edt_projects(configured, projects);
  result.projectReadiness = result.repositories.some(item => item.required && item.ready) && result.repositories.every(item => item.requirementsMet) ? "verified" : "not_ready";
  result.detail = edt_project_detail(result.repositories) || "Не найдены настроенные проекты для проверки готовности EDT.";
}
// Setup evidence is a bounded observation of a closed probe, never a workflow
// capability. Caller-supplied ready flags and deserialized JSON prove nothing.
export function setup_knowledge_status(profile, config, root, observation, state) {
  const knowledge = { ...knowledge_status(profile, config), readinessScope: "setup", koraReady: false };
  const proof = observation && observations.get(observation);
  if (knowledge.state !== "not_verified" || !proof || proof.key !== stable([resolve(root), profile, config]) ||
      proof.evidence !== knowledge_evidence_revision(config, root, profile, state) ||
      Date.now() < Date.parse(proof.status.readiness.checkedAt) || Date.now() >= Date.parse(proof.status.readiness.expiresAt)) return knowledge;
  return { ...knowledge, state: "ready", ready: true, lifecycle: "ready", searchReadiness: "ready",
    readiness: structuredClone(proof.status.readiness), detail: "Поиск по выбранным коллекциям подтверждён проверкой настройки; рабочий процесс должен проверить собственную сессию." };
}

// Read-only external acceptance for setup, without launching managed services,
// publishing their schemas to the model, or inventing native tool arguments.
export async function probe_connections(config, root, profile, state, component = null, includeYaxunit = false) {
  register_diagnostic_secrets(config);
  const observationKey = stable([resolve(root), profile, config]);
  const knowledge = knowledge_status(profile, config);
  const names = component ? [component] : ["edt", "v8std"];
  const testingChecks = [];
  if (!component && knowledge.state !== "disabled") names.push("openviking");
  const external = Object.fromEntries(await Promise.all(names.map(async name => {
    const finished = item => { item.checkedAt ||= new Date().toISOString(); return [name, item]; };
    if (name === "openviking" && ["invalid", "not_configured"].includes(knowledge.state))
      return finished({ configured: false, connected: false, ready: false, state: knowledge.state, failure: { category: "configuration" }, detail: knowledge.detail });
    const options = config.mcp.required[name] || config.mcp.optional[name];
    if (!options?.url || options.enabled === false) return finished({ configured: false, connected: false, ready: false, failure: { category: "configuration" } });
    if (name === "openviking") {
      const bounded = structuredClone(config);
      bounded.mcp.optional.openviking.timeout_seconds = Math.min(options.timeout_seconds || 20, 30);
      const adapter = new OpenVikingAdapter(profile, bounded, null, null, root, state);
      const result = { configured: true, connected: false, ready: false, access: "not_verified",
        searchReadiness: "not_verified", collections: knowledge.collections, detail: knowledge.detail };
      let timedOut = false, deadlineClose = null;
      const deadlineTimer = setTimeout(() => { timedOut = true; deadlineClose = adapter.close(); }, Math.min(options.timeout_seconds || 20, 25) * 1000);
      try {
        const evidence = knowledge_evidence_revision(config, root, profile, state);
        Object.assign(result, await adapter.connect()); Object.assign(result, await adapter.verifyReadiness());
        if (timedOut) throw new Error("Истекло общее время проверки OpenViking.");
        if (evidence !== knowledge_evidence_revision(config, root, profile, state)) throw new Error("Подтверждения знаний изменились во время проверки настройки; повторите проверку готовности");
        observations.set(result, { key: observationKey, evidence, status: structuredClone(result) });
      }
      catch (error) { Object.assign(result, adapter.status(), { ready: false, lifecycle: adapter.connected ? "connected" : "configured",
        searchReadiness: "not_verified", readiness: { state: "not_verified" }, failure: connection_failure(error, adapter.connected ? "index" : "configuration"), detail: safe_error_message(error) }); }
      finally { clearTimeout(deadlineTimer); await deadlineClose?.catch(() => {}); await adapter.close().catch(() => {}); }
      return finished(result);
    }
    const client = new RemoteMcp(options.url, Math.min(options.timeout_seconds || 20, 30), { headers_env: options.headers_env, maxBytes: options.max_response_bytes });
    const result = { configured: true, connected: false, ready: false, projectReadiness: "not_verified" };
    let deadlineClose = null, timedOut = false;
    const deadlineTimer = setTimeout(() => { timedOut = true; deadlineClose = client.close(); }, Math.min(options.timeout_seconds || 20, 25) * 1000);
    let phase = "authorization";
    try {
      client.credential_headers();
      phase = "transport";
      const init = await client.initialize();
      result.connected = true;
      result.server = sanitize_diagnostics({ name: init.serverInfo?.name, version: init.serverInfo?.version });
      phase = "server_contract";
      const tools = (await all_pages(client, "tools/list", "tools", name === "edt" && includeYaxunit ? { maxPages: 4, maxItems: 512 } : {})).tools;
      if (!tools.length) throw new Error("MCP не предоставляет инструментов.");
      result.toolsVerified = true;
      if (name === "edt") {
        let projectResponse;
        const list = tools.find(tool => tool.name === "list_projects");
        if (list && !(list.inputSchema?.required || []).some(field => field !== "format")) {
          const format = list.inputSchema?.properties?.format;
          const args = format?.enum?.includes("json") ? { format: "json" } : {};
          if (!(list.inputSchema?.required || []).length || Object.hasOwn(args, "format")) {
            const response = await client.request("tools/call", { name: list.name, arguments: args });
            projectResponse = response;
            if (response.isError) throw new Error(response.content?.find(item => item.type === "text")?.text || "Не удалось запросить проекты EDT");
            try { apply_edt_projects(result, root, profile, normalize_projects(response)); }
            catch (error) {
              if (error.code !== "unsupported_response") throw error;
              result.failure = { category: "server_contract" };
              result.detail = "EDT вернул неподдерживаемый или неполный список проектов; готовность не подтверждена.";
            }
          }
        }
        result.ready = result.projectReadiness === "verified";
        result.checkedAt = new Date().toISOString();
        if (includeYaxunit) testingChecks.push({ ...(await probe_yaxunit(config, root, profile, { client, tools, projectResponse })), checkedAt: new Date().toISOString() });
      }
      if (timedOut && !(name === "edt" && result.checkedAt)) throw new Error("Истекло общее время проверки подключения.");
      if (timedOut && name === "edt" && includeYaxunit && profile.testing.yaxunit === true)
        testingChecks.splice(0, testingChecks.length, { ...yaxunit_result("timeout"), checkedAt: new Date().toISOString() });
      if (name !== "edt") result.ready = true;
      if (!result.ready && !result.failure && (!result.repositories || result.repositories.some(item => !item.matched))) result.failure = { category: "access_scope" };
    } catch (error) {
      if (!(name === "edt" && result.checkedAt && timedOut)) { result.detail = safe_error_message(error); result.failure = connection_failure(error, phase); }
      if (name === "edt" && includeYaxunit && profile.testing.yaxunit === true && !testingChecks.length) testingChecks.push({ ...yaxunit_result(timedOut ? "timeout" : error.code === -32601 ? "api_unsupported" : result.connected ? "request_failed" : "edt_unavailable", { diagnostic: { failure: result.failure, detail: result.detail } }), checkedAt: new Date().toISOString() });
    }
    finally { clearTimeout(deadlineTimer); await deadlineClose; await client.close().catch(() => {}); }
    return finished(result);
  })));
  const status = setup_knowledge_status(profile, config, root, external.openviking, state);
  if (includeYaxunit && !testingChecks.length) testingChecks.push({ ...(profile.testing.yaxunit === true ? yaxunit_result(external.edt?.connected ? "api_unsupported" : "edt_unavailable", { diagnostic: external.edt?.failure }) : yaxunit_unchecked(profile)), checkedAt: new Date().toISOString() });
  return { projectRoot: root, external, ...(includeYaxunit ? { componentChecks: testingChecks } : {}), knowledge: status, verificationLimits: verification_limits(status.ready),
    scope: "setup_probe", fullReadiness: "not_verified", chatRelay: "not_verified",
    detail: "Проверено отдельное подключение к серверам; каталог инструментов и привязка relay текущего чата не проверены." };
}
