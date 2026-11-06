import { Ajv2020 } from "../vendor/deps.mjs";
import { RemoteMcp } from "./remote_client.mjs";
import { all_pages } from "./mcp_pages.mjs";
import { object } from "./common.mjs";

// Response dialects supported by EDT-MCP. Arguments are always checked against
// the live catalogue; this adapter never calls a launch or a mutation tool.
export const runtime_client_type = "com._1c.g5.v8.dt.launching.core.RuntimeClient";
const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
export class EdtLaunchError extends Error {
  constructor(code, tool, cause) { super(code, { cause }); this.code = code; this.tool = tool; }
}
const unsupported = tool => { throw new EdtLaunchError("unsupported_response", tool); };
function payload(response, tool) {
  if (!object(response)) return unsupported(tool);
  if (response.isError !== undefined && typeof response.isError !== "boolean") return unsupported(tool);
  if (response.isError === true) throw new EdtLaunchError("request_failed", tool);
  let data = response.structuredContent;
  if (data === undefined) {
    const parts = response.content?.filter(item => item.type === "text");
    if (parts?.length !== 1) return unsupported(tool);
    try { data = JSON.parse(parts[0].text); } catch { return unsupported(tool); }
  }
  if (object(data) && (data.success === false || data.error)) throw new EdtLaunchError("request_failed", tool);
  if (object(data) && data.success !== undefined && typeof data.success !== "boolean") return unsupported(tool);
  return data;
}
function rows(data, key, tool) {
  const items = Array.isArray(data) ? data : data?.[key];
  if (!Array.isArray(items) || items.length > 512 || items.some(item => !object(item)) ||
      data?.truncated === true || data?.partial === true || data?.complete === false || data?.hasMore === true || data?.nextCursor != null ||
      !Array.isArray(data) && data?.count !== undefined && data.count !== items.length) return unsupported(tool);
  return items;
}
export function normalize_projects(response) {
  const tool = "list_projects", items = rows(payload(response, tool), "projects", tool);
  // Closed projects and failed nature reads omit EDT-MCP's tri-state flag.
  if (items.some(item => !text(item.name) || !text(item.path) || typeof item.open !== "boolean" ||
      (item.edtProject !== undefined && typeof item.edtProject !== "boolean") || !text(item.state)) || new Set(items.map(item => item.name)).size !== items.length) return unsupported(tool);
  return items.map(({ name, path, open, edtProject, state }) => ({ name, path, open, edtProject, state }));
}
export function normalize_configurations(response) {
  const tool = "list_configurations", items = rows(payload(response, tool), "configurations", tool);
  if (items.some(item => !text(item.name) || !text(item.type) ||
      ["project", "applicationId"].some(key => item[key] !== undefined && !text(item[key])) ||
      item.attach !== undefined && typeof item.attach !== "boolean") || new Set(items.map(item => item.name)).size !== items.length) return unsupported(tool);
  return items.map(({ name, type, project, applicationId, attach }) => ({ name, type, project, applicationId, client: type === runtime_client_type && attach !== true }));
}
export function normalize_applications(response, projectName) {
  const tool = "get_applications", data = payload(response, tool), items = rows(data, "applications", tool);
  if (!object(data) || data.project !== projectName || items.some(item => !text(item.id)) ||
      new Set(items.map(item => item.id)).size !== items.length ||
      data.inheritedFromProject !== undefined && !text(data.inheritedFromProject) ||
      data.defaultApplicationId !== undefined && (!text(data.defaultApplicationId) || !items.some(item => item.id === data.defaultApplicationId))) return unsupported(tool);
  return { projectName, owner: data.inheritedFromProject || projectName, defaultId: data.defaultApplicationId,
    applications: items.map(({ id }) => ({ id })) };
}

export async function read_edt_launch(options, projectNames, verifyProjects, session = null) {
  if (projectNames.length > 16) throw new EdtLaunchError("api_limit");
  const seconds = Math.min(options.timeout_seconds || 20, 30);
  const client = session?.client || new RemoteMcp(options.url, seconds, { headers_env: options.headers_env, maxBytes: options.max_response_bytes });
  let timedOut = false, deadlineClose = null, phase = "connect";
  const timer = setTimeout(() => { timedOut = true; deadlineClose = client.close(); }, seconds * 1000);
  try {
    if (!session) await client.initialize();
    phase = "catalogue";
    const tools = session?.tools || (await all_pages(client, "tools/list", "tools", { maxPages: 4, maxItems: 512 })).tools;
    const ajv = new Ajv2020({ strict: false, ownProperties: true, validateFormats: false });
    const validators = new Map();
    const argsFor = (name, args) => {
      const tool = tools.find(item => item.name === name), schema = tool?.inputSchema;
      if (!object(schema) || Object.keys(args).some(key => !Object.hasOwn(schema.properties || {}, key))) throw new EdtLaunchError("api_unsupported", name);
      try {
        if (!validators.has(name)) validators.set(name, ajv.compile(schema));
        if (!validators.get(name)(args)) throw new Error("Arguments unsupported");
      } catch (cause) { throw new EdtLaunchError("api_unsupported", name, cause); }
      return args;
    };
    const call = async (name, args) => {
      phase = name;
      argsFor(name, args);
      return client.request("tools/call", { name, arguments: args });
    };
    const format = tools.find(item => item.name === "list_projects")?.inputSchema?.properties?.format;
    if (session) argsFor("list_projects", format?.enum?.includes("json") ? { format: "json" } : {});
    const projects = normalize_projects(session && Object.hasOwn(session, "projectResponse") ? session.projectResponse
      : await call("list_projects", format?.enum?.includes("json") ? { format: "json" } : {}));
    const projectIssue = verifyProjects(projects);
    if (projectIssue) return { projectIssue };
    const configurations = normalize_configurations(await call("list_configurations", {}));
    const applications = [];
    for (const projectName of projectNames) applications.push(normalize_applications(await call("get_applications", { projectName }), projectName));
    // Inspect the runner contract without invoking it.
    return { configurations, applications, supports: args => {
      argsFor("run_yaxunit_tests", args);
      return true;
    } };
  } catch (cause) {
    if (cause instanceof EdtLaunchError) throw cause;
    throw new EdtLaunchError(timedOut ? "timeout" : cause.code === -32601 ? "api_unsupported" : phase === "connect" ? "edt_unavailable" : phase === "catalogue" && cause.remote !== true ? "unsupported_response" : "request_failed", phase, cause);
  } finally { clearTimeout(timer); await deadlineClose; if (!session) await client.close(); }
}
