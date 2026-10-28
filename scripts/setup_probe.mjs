import path from "node:path";
import { RemoteMcp } from "./remote_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import { resolve } from "./project_paths.mjs";
import { knowledge_status } from "./knowledge.mjs";
import { OpenVikingAdapter } from "./openviking_adapter.mjs";
import { stable } from "./common.mjs";
import { knowledge_evidence_revision } from "./components.mjs";
import { connection_failure, verification_limits, safe_error_message, register_diagnostic_secrets, sanitize_diagnostics } from "./diagnostics.mjs";

const observations = new WeakMap();
function edt_project_detail(repositories) {
  const lines = repositories.map(item => {
    let status = "готов";
    if (!item.matched) status = "имя и путь не сопоставлены с проектом EDT";
    else if (item.open !== true) status = "проект не открыт или его состояние открытия не подтверждено";
    else if (item.state === "building") status = "EDT сообщает о сборке проекта";
    else if (!item.ready) status = "готовность проекта EDT не подтверждена";
    return item.id + ": " + status;
  });
  if (repositories.some(item => item.matched && item.open === true && item.state === "building"))
    lines.push("Дождитесь завершения сборки в EDT и повторите проверку готовности. Если сборка не завершается, проверьте операции и ошибки в EDT.");
  return lines.join("\n");
}
// Setup evidence is a bounded observation of a closed probe, never a workflow
// capability. Caller-supplied ready flags and deserialized JSON prove nothing.
export function setup_knowledge_status(profile, config, root, observation) {
  const knowledge = { ...knowledge_status(profile, config), readinessScope: "setup", koraReady: false };
  const proof = observation && observations.get(observation);
  if (knowledge.state !== "not_verified" || !proof || proof.key !== stable([resolve(root), profile, config]) ||
      proof.evidence !== knowledge_evidence_revision(config, root, profile) ||
      Date.now() < Date.parse(proof.status.readiness.checkedAt) || Date.now() >= Date.parse(proof.status.readiness.expiresAt)) return knowledge;
  return { ...knowledge, state: "ready", ready: true, lifecycle: "ready", searchReadiness: "ready",
    readiness: structuredClone(proof.status.readiness), detail: "Поиск по выбранным коллекциям подтверждён проверкой настройки; рабочий процесс должен проверить собственную сессию." };
}

// Read-only external acceptance for setup, without launching managed services,
// publishing their schemas to the model, or inventing native tool arguments.
export async function probe_connections(config, root, profile) {
  register_diagnostic_secrets(config);
  const observationKey = stable([resolve(root), profile, config]);
  const knowledge = knowledge_status(profile, config);
  const names = ["edt", "v8std"];
  if (knowledge.state !== "disabled") names.push("openviking");
  const external = Object.fromEntries(await Promise.all(names.map(async name => {
    if (name === "openviking" && ["invalid", "not_configured"].includes(knowledge.state))
      return [name, { configured: false, connected: false, ready: false, state: knowledge.state, failure: { category: "configuration" }, detail: knowledge.detail }];
    const options = config.mcp.required[name] || config.mcp.optional[name];
    if (!options?.url || options.enabled === false) return [name, { configured: false, connected: false, ready: false, failure: { category: "configuration" } }];
    if (name === "openviking") {
      const bounded = structuredClone(config);
      bounded.mcp.optional.openviking.timeout_seconds = Math.min(options.timeout_seconds || 20, 30);
      const adapter = new OpenVikingAdapter(profile, bounded, null, null, root);
      const result = { configured: true, connected: false, ready: false, access: "not_verified",
        searchReadiness: "not_verified", collections: knowledge.collections, detail: knowledge.detail };
      try {
        const evidence = knowledge_evidence_revision(config, root, profile);
        Object.assign(result, await adapter.connect()); Object.assign(result, await adapter.verifyReadiness());
        if (evidence !== knowledge_evidence_revision(config, root, profile)) throw new Error("Knowledge evidence changed during the setup probe; repeat readiness");
        observations.set(result, { key: observationKey, evidence, status: structuredClone(result) });
      }
      catch (error) { Object.assign(result, adapter.status(), { ready: false, lifecycle: adapter.connected ? "connected" : "configured",
        searchReadiness: "not_verified", readiness: { state: "not_verified" }, failure: connection_failure(error, adapter.connected ? "index" : "configuration"), detail: safe_error_message(error) }); }
      finally { await adapter.close().catch(() => {}); }
      return [name, result];
    }
    const client = new RemoteMcp(options.url, Math.min(options.timeout_seconds || 20, 30), { headers_env: options.headers_env, maxBytes: options.max_response_bytes });
    const result = { configured: true, connected: false, ready: false, projectReadiness: "not_verified" };
    let phase = "authorization";
    try {
      client.credential_headers();
      phase = "transport";
      const init = await client.initialize();
      result.connected = true;
      result.server = sanitize_diagnostics({ name: init.serverInfo?.name, version: init.serverInfo?.version });
      phase = "server_contract";
      const tools = (await all_pages(client, "tools/list", "tools")).tools;
      if (!tools.length) throw new Error("MCP не предоставляет инструментов.");
      result.toolsVerified = true;
      if (name === "edt") {
        const list = tools.find(tool => tool.name === "list_projects");
        if (list && !(list.inputSchema?.required || []).some(field => field !== "format")) {
          const format = list.inputSchema?.properties?.format;
          const args = format?.enum?.includes("json") ? { format: "json" } : {};
          if (!(list.inputSchema?.required || []).length || Object.hasOwn(args, "format")) {
            const response = await client.request("tools/call", { name: list.name, arguments: args });
            if (response.isError) throw new Error(response.content?.find(item => item.type === "text")?.text || "EDT project query failed");
            let payload = response.structuredContent;
            if (!payload) try { payload = JSON.parse(response.content?.find(item => item.type === "text")?.text); } catch { /* no structured project evidence */ }
            const projects = Array.isArray(payload) ? payload : payload?.projects;
            if (Array.isArray(projects)) {
              result.repositories = profile.repositories.map(repository => {
                const project = projects.find(item => item.name === repository.edt_project && typeof item.path === "string" && resolve(item.path) === resolve(path.join(root, repository.path)));
                return { id: repository.id, matched: Boolean(project), ready: Boolean(project?.open === true && project?.state === "ready" && project?.edtProject === true), ...(project ? { state: project.state, open: project.open } : {}) };
              });
              result.projectReadiness = result.repositories.length && result.repositories.every(item => item.ready) ? "verified" : "not_ready";
              if (result.projectReadiness !== "verified") result.detail = edt_project_detail(result.repositories);
            }
          }
        }
      }
      result.ready = name === "edt" ? result.projectReadiness === "verified" : true;
      if (!result.ready && (!result.repositories || result.repositories.some(item => !item.matched))) result.failure = { category: "access_scope" };
    } catch (error) { result.detail = safe_error_message(error); result.failure = connection_failure(error, phase); }
    finally { await client.close().catch(() => {}); }
    return [name, result];
  })));
  const status = setup_knowledge_status(profile, config, root, external.openviking);
  return { projectRoot: root, external, knowledge: status, verificationLimits: verification_limits(status.ready),
    scope: "setup_probe", fullReadiness: "not_verified" };
}
