// Knowledge configuration is project-owned; transport alone never selects it.
import { ConfigError } from "./project_paths.mjs";
import { check_schema, validate_url } from "./common.mjs";

export const WORKFLOW_ACTIONS = Object.freeze(["discovery", "design", "implementation", "review", "runtime"]);

export function knowledge_status(profile, config) {
  const { provider, mode = provider === "none" ? "disabled" : null, collections = [], required = false, dependent_actions = [] } = profile?.knowledge || {};
  const transport = config?.mcp?.optional?.openviking;
  const result = { provider, mode, collections: structuredClone(collections), required, dependentActions: structuredClone(dependent_actions),
    coverage: "not_verified", coverageScope: "selected_collections", apiExistence: "not_determined",
    workflowScope: mode === "kora" ? "all" : "dependent_actions", koraReady: false };
  try {
    check_schema(profile, "project-profile.schema.json");
    check_schema(config, "plugin-settings.schema.json");
    if (transport?.url) validate_url(transport.url, "OpenViking");
  } catch (error) {
    return { ...result, state: "invalid", detail: "Invalid knowledge configuration: " + error.message };
  }
  if (provider === "none") return { ...result, state: transport?.enabled ? "invalid" : "disabled",
    detail: transport?.enabled ? "OpenViking transport is enabled but knowledge.provider is none." : "Knowledge is explicitly disabled; no knowledge coverage is claimed." };
  const configured = transport?.enabled === true && Boolean(transport.url);
  return { ...result, state: configured ? "not_verified" : "not_configured",
    detail: configured ? "Search readiness for the selected collections has not been verified."
      : "OpenViking transport is disabled or its URL is empty; the profile's knowledge requirements remain in force." };
}

// This decision only constrains knowledge dependencies; it grants no authority
// or permission and cannot replace the shared action policy.
export function knowledge_gate(profile, config, action) {
  const knowledge = knowledge_status(profile, config);
  const dependent = knowledge.mode === "kora" || action === "knowledge_search" || knowledge.required && Array.isArray(knowledge.dependentActions) && knowledge.dependentActions.includes(action);
  const blocked = knowledge.state === "invalid" || dependent && knowledge.state !== "ready";
  return { allowed: !blocked, action, dependent, knowledge,
    ...(blocked ? { reason: knowledge.detail } : {}) };
}

export function require_workflow_knowledge(profile, config) {
  const gate = knowledge_gate(profile, config, "workflow");
  if (!gate.allowed) throw new ConfigError("Knowledge workflow blocked: " + gate.reason);
  return gate;
}
