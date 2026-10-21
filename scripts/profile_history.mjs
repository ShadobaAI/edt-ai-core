import fs from "node:fs";
import path from "node:path";
import { atomic_write } from "./common.mjs";
import { profile_state } from "./profile.mjs";
import { is_dir, is_file, path_identity, project_directory, record_project_owner } from "./project_paths.mjs";

// User state survives plugin upgrades. Never scan unrelated project directories.
export function remember_profile(state, root, profile) {
  if (!root || profile?.status !== "loaded") return;
  // History failure must not turn an already saved profile into a failed operation.
  try {
    record_project_owner(state, root);
    atomic_write(path.join(project_directory(state, root), "profile-history.json"), JSON.stringify({
      root: path_identity(root), lastOpened: new Date().toISOString(),
      profileId: profile.profileId, projectId: profile.projectId, repositoryCount: profile.repositories.length,
    }));
  } catch { return false; }
  return true;
}

export function profile_history(state, selectedRoot = null) {
  const projects = path.join(state, "projects"), records = new Map();
  let directories=[];try { directories=fs.readdirSync(projects, { withFileTypes: true }); } catch {}
  for (const entry of directories) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const home = path.join(projects, entry.name);
    let owner, visit = {};
    try { owner = JSON.parse(fs.readFileSync(path.join(home, "project-owner.json"), "utf8")).root; }
    catch { try { owner = JSON.parse(fs.readFileSync(path.join(home, "code-index/owner.json"), "utf8")).project_root; } catch {} }
    if (typeof owner !== "string" || !path.isAbsolute(owner)) continue;
    try { visit = JSON.parse(fs.readFileSync(path.join(home, "profile-history.json"), "utf8")); } catch {}
    if (!visit || typeof visit !== "object" || visit.root !== owner) visit = {};
    const item = { projectRoot: owner, lastOpened: typeof visit.lastOpened === "string" && Number.isFinite(Date.parse(visit.lastOpened)) ? visit.lastOpened : null,
      projectId: typeof visit.projectId === "string" ? visit.projectId : null,
      profileId: typeof visit.profileId === "string" ? visit.profileId : null,
      repositoryCount: Number.isInteger(visit.repositoryCount) && visit.repositoryCount >= 0 ? visit.repositoryCount : 0 };
    try {
      const profile = !is_dir(owner) ? { status: "unavailable" }
        : !is_file(path.join(owner, ".ai/project.yaml")) ? { status: "missing" } : profile_state(owner);
      Object.assign(item, { status: profile.status, detail: profile.detail,
        projectId: profile.projectId || item.projectId, profileId: profile.profileId || item.profileId,
        repositoryCount: profile.repositories?.length ?? item.repositoryCount });
    } catch (error) { item.status = "unavailable"; item.detail = error.message; }
    item.selected = selectedRoot === owner;
    const previous = records.get(owner);
    if (!previous || (item.lastOpened || "") > (previous.lastOpened || "")) records.set(owner, item);
  }
  return [...records.values()].sort((a, b) => (b.lastOpened || "").localeCompare(a.lastOpened || "") || a.projectRoot.localeCompare(b.projectRoot));
}

// Passive observation only: no installation, preparation, process launch or MCP probe.
export async function profile_summary(state, config, profile) {
  const root = config.active_project, components = [];
  for (const id of ["code-index", "bsl-ls"]) {
    const options = config.mcp.managed[id];
    let status = options.enabled === false ? "disabled" : options.mode === "external" ? "external" : "not_checked";
    if (id === "code-index" && status === "not_checked" && root && profile.status === "loaded") {
      const { daemon_health } = await import("./runtime.mjs");
      const health = await daemon_health(path.join(project_directory(state, root), "code-index"));
      status = health ? "running" : "stopped";
    }
    components.push({ id, status });
  }
  return { observedAt: new Date().toISOString(), profile: profile.status, components };
}
