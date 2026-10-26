import path from "node:path";
import { RemoteMcp } from "./remote_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import { resolve } from "./project_paths.mjs";
import { knowledge_status } from "./knowledge.mjs";
import { OpenVikingAdapter } from "./openviking_adapter.mjs";

// Read-only external acceptance for setup, without launching managed services,
// publishing their schemas to the model, or inventing native tool arguments.
export async function probe_connections(config, root, profile) {
  const knowledge = knowledge_status(profile, config);
  const names = ["edt", "v8std"];
  if (knowledge.state !== "disabled") names.push("openviking");
  const external = Object.fromEntries(await Promise.all(names.map(async name => {
    if (name === "openviking" && ["invalid", "not_configured"].includes(knowledge.state))
      return [name, { configured: false, connected: false, ready: false, state: knowledge.state, detail: knowledge.detail }];
    const options = config.mcp.required[name] || config.mcp.optional[name];
    if (!options?.url || options.enabled === false) return [name, { configured: false, connected: false, ready: false }];
    if (name === "openviking") {
      const bounded = structuredClone(config);
      bounded.mcp.optional.openviking.timeout_seconds = Math.min(options.timeout_seconds || 20, 30);
      const adapter = new OpenVikingAdapter(profile, bounded);
      const result = { configured: true, connected: false, ready: false, access: "not_verified",
        searchReadiness: "not_verified", collections: knowledge.collections, detail: knowledge.detail };
      try { Object.assign(result, await adapter.connect()); }
      catch (error) { result.detail = error.message; }
      finally { await adapter.close().catch(() => {}); }
      return [name, result];
    }
    const client = new RemoteMcp(options.url, Math.min(options.timeout_seconds || 20, 30), { headers_env: options.headers_env, maxBytes: options.max_response_bytes });
    const result = { configured: true, connected: false, ready: false, projectReadiness: "not_verified" };
    try {
      const init = await client.initialize();
      result.connected = true;
      result.server = { name: init.serverInfo?.name, version: init.serverInfo?.version };
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
            }
          }
        }
      }
      result.ready = name === "edt" ? result.projectReadiness === "verified" : true;
    } catch (error) { result.detail = error.message; }
    finally { await client.close().catch(() => {}); }
    return [name, result];
  })));
  return { projectRoot: root, external, knowledge, fullReadiness: "not_verified" };
}
