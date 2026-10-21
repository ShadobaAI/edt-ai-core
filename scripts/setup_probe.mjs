import path from "node:path";
import { RemoteMcp } from "./remote_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import { resolve } from "./project_paths.mjs";

// Read-only external acceptance for setup, without launching managed services,
// publishing their schemas to the model, or inventing native tool arguments.
export async function probe_connections(config, root, profile) {
  const external = Object.fromEntries(await Promise.all(["edt", "v8std"].map(async name => {
    const options = config.mcp.required[name];
    if (!options.url) return [name, { configured: false, connected: false }];
    const client = new RemoteMcp(options.url, Math.min(options.timeout_seconds || 20, 30), { headers_env: options.headers_env, maxBytes: options.max_response_bytes });
    const result = { configured: true, connected: false, projectReadiness: "not_verified" };
    try {
      const init = await client.initialize();
      result.connected = true;
      result.server = { name: init.serverInfo?.name, version: init.serverInfo?.version };
      if (name === "edt") {
        const tools = (await all_pages(client, "tools/list", "tools")).tools;
        const list = tools.find(tool => tool.name === "list_projects");
        if (list && !(list.inputSchema?.required || []).some(field => field !== "format")) {
          const format = list.inputSchema?.properties?.format;
          const args = format?.enum?.includes("json") ? { format: "json" } : {};
          if (!(list.inputSchema?.required || []).length || Object.hasOwn(args, "format")) {
            const response = await client.request("tools/call", { name: list.name, arguments: args });
            if (response.isError) throw new Error(response.content?.find(item => item.type === "text")?.text || "EDT project query failed");
            const projects = response.structuredContent?.projects;
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
    } catch (error) { result.detail = error.message; }
    finally { await client.close().catch(() => {}); }
    return [name, result];
  })));
  return { projectRoot: root, external, fullReadiness: "not_verified" };
}
