import path from "node:path";
import { load } from "./common.mjs";
import { core_version } from "./compatibility.mjs";
import { require_preparation } from "./components.mjs";
import { resolve } from "./project_paths.mjs";

function same_endpoint(left, right) {
  try {
    const normalize = value => {
      const url = new URL(value);
      if (url.hostname === "localhost") url.hostname = "127.0.0.1";
      return url.href;
    };
    return normalize(left) === normalize(right);
  } catch { return left === right; }
}

// One bounded snapshot for the model. Native settings keep their full UI schema.
export function setup_inspection(read, state) {
  const { values, profile, directoryContext, instance, connectionSources, preparationScope, operation, projectSelection } = read;
  let document;
  try { if (profile.path) document = load(profile.path); } catch { /* profile.detail contains validation failure */ }
  const repositories = (Array.isArray(document?.repositories) ? document.repositories : []).filter(item => item && typeof item === "object").map(({ id, path: directory, alias, edt_project }) => ({ id, path: directory, alias, edt_project }));
  const detected = directoryContext?.edt?.connection;
  const issues = [];
  const next = [];
  if (projectSelection?.detail) next.push("resolve_host_directory");
  else if (!values.projectRoot) next.push("select_directory");
  else if (profile.status === "missing") next.push("create_profile");
  else if (profile.status !== "loaded") next.push("repair_profile");
  if (detected?.url && values.edtUrl && !same_endpoint(detected.url, values.edtUrl))
    issues.push({ code: "edt_endpoint_mismatch", effective: values.edtUrl, detected: detected.url, source: connectionSources?.edt, resolution: "Verify the assigned EDT before changing an explicit URL; detection never overrides it automatically." });
  const projects = directoryContext?.edt?.projects || [];
  if (profile.status === "loaded") {
    if (!repositories.length) next.push("configure_repositories");
    for (const repository of repositories) {
      const candidate = projects.find(item => resolve(item.directory) === resolve(path.join(values.projectRoot, repository.path)));
      if (candidate && repository.edt_project !== candidate.name)
        issues.push({ code: "edt_project_name_mismatch", repository: repository.id, configured: repository.edt_project, detected: candidate.name });
    }
    if (!values.edtUrl || !values.v8stdUrl) next.push("configure_connections");
  }
  const managed = Object.fromEntries([["code-index", values.codeIndexEnabled], ["bsl-ls", values.bslLsEnabled]].map(([name, enabled]) => {
    let prepared = false;
    try { if (values.projectRoot) { require_preparation(state, values.projectRoot, name); prepared = true; } } catch { /* no preparation grant */ }
    return [name, { enabled, preparationAuthorized: prepared }];
  }));
  if (profile.status === "loaded" && Object.values(managed).some(item => item.enabled && !item.preparationAuthorized)) next.push("prepare_managed_with_authorization");
  if (profile.status === "loaded" && values.edtUrl && values.v8stdUrl) next.push("probe_connections");
  return {
    coreVersion: core_version, projectRoot: values.projectRoot, instance, profile: { ...profile, ...(document?.compatibility ? { compatibility: document.compatibility } : {}) },
    values, connectionSources, repositories, managed, preparationScope, projectSelection, operation,
    detected: { edt: detected || null, projects, ...(directoryContext?.edt?.errors ? { errors: directoryContext.edt.errors } : {}) },
    issues, nextSteps: next, readiness: read.readiness,
    bindingGuidance: "When a runtime's selectedDirectory is empty, call its core_runtime_status with this projectRoot once. A new chat/restart does not supply missing roots. Do not spawn substitute relays or inspect plugin source for setup.",
  };
}
