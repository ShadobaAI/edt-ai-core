// Local setup evidence only: no source reads, network calls or runtime launches.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolve, contained, is_file, is_dir, exists, project_directories } from "./project_paths.mjs";

const PREFS = ".metadata/.plugins/org.eclipse.core.runtime/.settings/com.ditrix.edt.mcp.server.prefs";
function text_file(file, root) {
  if (!is_file(file)) return null;
  if (!contained(root, resolve(file))) throw new Error("Metadata file leaves its directory: " + file);
  if (fs.statSync(file).size > 1024 * 1024) throw new Error("Metadata file exceeds 1 MiB: " + file);
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}
export function edt_connection(selected) {
  for (let workspace = resolve(selected); ; workspace = path.dirname(workspace)) {
    // The nearest workspace owns this directory, even if MCP prefs are absent.
    if (is_dir(path.join(workspace, ".metadata"))) {
      const preferences = path.join(workspace, PREFS);
      try {
        const text = text_file(preferences, workspace);
        if (text === null) return { status: "missing_preferences", workspace, preferences, liveVerified: false };
        const ports = [...text.matchAll(/^[\t ]*mcpServerPort[\t ]*[=:][\t ]*([^\r\n]*?)[\t ]*\r?$/gm)];
        const value = ports.at(-1)?.[1], port = value === undefined ? 8765 : Number(value);
        if (value !== undefined && (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535))
          return { status: "invalid_port", workspace, preferences, liveVerified: false };
        return { status: "detected", workspace, preferences, port,
          portSource: value === undefined ? "default" : "mcpServerPort",
          url: `http://127.0.0.1:${port}/mcp`, liveVerified: false };
      } catch (error) {
        return { status: "unavailable", workspace, preferences, detail: error.message, liveVerified: false };
      }
    }
    if (path.dirname(workspace) === workspace) return { status: "workspace_not_found", liveVerified: false };
  }
}
function xml_text(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
    const names = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (names[entity]) return names[entity];
    const number = entity.startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  }).trim();
}
// Check basic descriptor structure without using the name's value for identity.
// This is not full XML validation or proof that EDT has loaded the project.
function descriptor_text(file, root) {
  const text = text_file(file, root)?.replace(/<!--[\s\S]*?-->/g, "");
  if (!text || /<!DOCTYPE|<!ENTITY/i.test(text) || !/<\/projectDescription\s*>\s*$/.test(text)) return null;
  if (!/<projectDescription\s*>\s*<name\s*>[^<]*<\/name>/.test(text)) return null;
  return text;
}
function descriptor_name(file, root) {
  const declared = descriptor_text(file, root)?.match(/<projectDescription\s*>\s*<name\s*>([^<]*)<\/name>/)?.[1];
  return declared ? xml_text(declared) : null;
}
export function edt_port_suggestion(effectiveUrl, detected) {
  if (!effectiveUrl || detected?.status !== "detected") return null;
  try {
    const current = new URL(effectiveUrl);
    // A remote EDT is not owned by the local workspace preferences.
    if (!["localhost", "127.0.0.1", "[::1]"].includes(current.hostname)) return null;
    const configuredPort = Number(current.port || (current.protocol === "https:" ? 443 : 80));
    if (configuredPort === detected.port) return null;
    current.port = String(detected.port);
    return { configuredPort, detectedPort: detected.port, url: current.href, preferences: detected.preferences, workspace: detected.workspace };
  } catch { return null; }
}
export function edt_project_descriptors(selected, { includeDisplayName = false } = {}) {
  if (!selected) return null;
  const root = resolve(selected);
  const projects = [];
  try {
    for (const directory of project_directories(root)) {
      const descriptor = path.join(directory, ".project");
      if (!is_file(descriptor) || !contained(root, resolve(descriptor))) continue;
      let displayName = null;
      if (includeDisplayName) try { displayName = descriptor_name(descriptor, root); } catch { /* Keep the directory in the inventory. */ }
      projects.push({ directory, name: path.basename(directory), descriptor, ...(displayName ? { displayName } : {}) });
    }
    return projects;
  } catch { return null; }
}
export function edt_project_count(selected) {
  return edt_project_descriptors(selected)?.length ?? null;
}
// A repository can contain an EDT project below its root (for example an
// extension in a framework repository). Never infer an EDT connection from
// this local metadata; live readiness is checked separately.
export function repository_projects(root, repositories, descriptors) {
  return repositories.map(repository => {
    const directory = resolve(path.join(root, repository.path));
    if (!contained(resolve(root), directory)) throw new Error("Repository directory leaves project root: " + repository.path);
    const found = descriptors ?? edt_project_descriptors(directory);
    if (!found) throw new Error("Не удалось проверить файлы .project: " + repository.path);
    const projects = found.filter(item => contained(directory, item.directory) && contained(directory, resolve(item.descriptor)) && (!repository.edt_project ||
      (path.basename(item.directory) === repository.edt_project &&
      (() => { try { return descriptor_text(item.descriptor, directory) !== null; } catch { return false; } })())));
    return { repository, projects };
  });
}
export function index_repositories(root, data, descriptors) {
  return repository_projects(root, data.repositories, descriptors).filter(item => item.projects.length).map(item => item.repository);
}
export function index_selection(root, data) {
  const unbound = new Set(data.policy?.unbound_edt_repositories || []);
  const found = repository_projects(root, data.repositories);
  return { repositories: found.filter(item => item.projects.length).map(item => item.repository),
    missingProjects: found.filter(({repository, projects}) => !unbound.has(repository.id) &&
      (repository.edt_project || (data.policy?.edt_repository_ids || []).includes(repository.id)) && projects.length !== 1)
      .map(item => item.repository.id) };
}
export function edt_projects(selected) {
  const root = resolve(selected), projects = [], errors = [], found = new Set();
  try {
    for (const directory of project_directories(root, directory => found.has(directory))) {
      if (!is_dir(path.join(directory, "src")) || !is_dir(path.join(directory, "DT-INF"))) continue;
      try {
        const descriptor = text_file(path.join(directory, ".project"), root),
          manifest = text_file(path.join(directory, "DT-INF/PROJECT.PMF"), root);
        if (descriptor === null || manifest === null) continue;
        // Read the project name, never a builder/reference's nested <name>.
        const nameElement = /<projectDescription\s*>\s*<name\s*>[^<]*<\/name>/.test(descriptor.replace(/<!--[\s\S]*?-->/g, ""));
        if (!nameElement || /<!DOCTYPE|<!ENTITY/i.test(descriptor)) continue;
        const source = resolve(path.join(directory, "src"));
        if (!contained(root, source)) throw new Error("EDT sources leave the selected directory: " + source);
        const runtimeVersion = manifest.replace(/\r?\n /g, "").match(/^Runtime-Version:[\t ]*([^\r\n]*)\r?$/m)?.[1]?.trim() || null;
        projects.push({ directory, name: path.basename(directory), source, runtimeVersion,
          settingsDirectory: is_dir(path.join(directory, ".settings")) ? path.join(directory, ".settings") : null });
        found.add(directory);
      } catch (error) { errors.push({ directory, detail: error.message }); }
    }
  } catch (error) { errors.push({ directory: root, detail: error.message }); }
  return { projects, ...(errors.length ? { errors } : {}) };
}
export function git_context(selected) {
  const directory = resolve(selected);
  // Git is optional. No status scan, hooks, fetch or remote configuration reads.
  let marker = directory;
  while (!exists(path.join(marker, ".git"))) {
    if (path.dirname(marker) === marker) return { status: "not_repository" };
    marker = path.dirname(marker);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  const git = args => spawnSync("git", ["--no-optional-locks", "-C", directory, ...args], {
    env, encoding: "utf8", windowsHide: true, shell: false, timeout: 2000, maxBuffer: 1024 * 1024,
  });
  const location = git(["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
  if (location.error || location.status !== 0) return { status: "unavailable",
    reason: location.error?.code === "ENOENT" ? "git_not_found" : location.error?.code === "ETIMEDOUT" ? "timeout" :
      /detected dubious ownership/i.test(location.stderr || "") ? "ownership_check" : "repository_unreadable" };
  const [root, gitDirectory] = location.stdout.trim().split(/\r?\n/),
    branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    head = git(["rev-parse", "--verify", "HEAD"]);
  if (branch.error || head.error || ![0, 1].includes(branch.status) || ![0, 128].includes(head.status))
    return { status: "unavailable", root, gitDirectory };
  return { status: "detected", root: resolve(root), gitDirectory: resolve(gitDirectory), branch: branch.status === 0 ? branch.stdout.trim() : null,
    commit: head.status === 0 ? head.stdout.trim() : null, detached: branch.status === 1 };
}
export function directory_context(selected, { includeDisplayName = false } = {}) {
  if (!selected) return null;
  const directory = resolve(selected);
  const detectedProjects = edt_project_descriptors(directory, { includeDisplayName });
  return { directory, edt: { ...edt_projects(directory), detectedProjects, projectCount: detectedProjects?.length ?? null, connection: edt_connection(directory) }, git: git_context(directory) };
}
