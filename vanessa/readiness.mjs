import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { path_identity } from "../scripts/project_paths.mjs";
import { windows_process_identity, windows_testclient_binding } from "../scripts/windows_process.mjs";
import { callTool } from "./mcp.mjs";
import { connectionString, clientAdditionalParameters, configuredUser } from "./profile.mjs";
import { invalidateObservedIdle } from "./recording.mjs";
import { runtimeContract, platformTokens } from "./runtime-contract.mjs";
export { runtimeContract } from "./runtime-contract.mjs";

// Runtime-specific parsers are deliberately separate from orchestration. They must be
// established from actual runtime responses before their fields can assert readiness.
export const requiredTools = ["get_environment_data", "get_vanessa_automation_state", "get_editor_state", "manage_test_client_profiles", "manage_test_client", "get_extension_list", "get_process_list_os", "open_feature_file", "check_syntax", "get_test_results", "get_window_list_os"];
const unverified = (reason, evidence) => ({ status: "unverified", reason, evidence });
const error = reason => ({ status: "error", reason });
export function isLocalComputer(value) {
  return typeof value === "string" && ["localhost", "127.0.0.1", "::1", os.hostname().toLowerCase()].includes(value.toLowerCase());
}
export function taxiCompatible(parameters) {
  if (typeof parameters !== "string") return false;
  const switches = [...parameters.matchAll(/(?:^|\s)\/(itaxi|itdi)(?=\s|$)/gi)].map(match => match[1].toLowerCase());
  return switches.includes("itaxi") && !switches.includes("itdi");
}
export function sameInfobase(expected, actual) {
  if (!actual || actual.type !== expected.type) return false;
  if (expected.type === "file") {
    const left = fileIdentity(expected.path), right = fileIdentity(actual.path);
    return left !== null && right !== null && left === right;
  }
  return typeof actual.server === "string" && typeof actual.database === "string" && actual.server.toLowerCase() === expected.server.toLowerCase() && actual.database.toLowerCase() === expected.database.toLowerCase();
}
function fileIdentity(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  try {
    if (!fs.statSync(file).isDirectory()) return null;
    return path_identity(file);
  } catch { return null; }
}
function selectedProcess(profile, profiles, inventory) {
  if (!inventory || inventory.filter !== null || !Array.isArray(inventory.processes) || inventory.matchedCount !== inventory.processes.length ||
      inventory.processes.some(item => !["test_client", "other"].includes(item.kind))) return null;
  const processes = inventory.processes.filter(item => item.kind === "test_client");
  if (!processes.length) return null;
  const connected = profiles.filter(item => item.connected === true);
  if (profiles.some(item => typeof item.connected !== "boolean") || connected.length !== 1 || connected[0].name !== profile.client.name) return null;
  if (processes.length === 1) return { process: processes[0], source: "unique_global_os_testclient", requirePid: false };
  // The PID chooses a candidate only; the socket proof below establishes
  // which process is actually connected to this MCP manager.
  const pid = connected[0].pid;
  if (!Number.isInteger(pid) || pid < 1 || profiles.filter(item => item.pid === pid).length !== 1) return null;
  const matches = processes.filter(item => item.pid === pid);
  return matches.length === 1 ? { process: matches[0], source: "profile_pid_and_tcp_binding", requirePid: true } : null;
}
async function processInventory(client, tools, contract) {
  try {
    // Filtered inventories cannot reveal a 1C process whose command line is
    // unavailable. Ask for every 1C process, without a truncating limit.
    const raw = await callTool(client, tools, "get_process_list_os", { only_1c: true, limit: 0 });
    const inventory = contract.processes?.(raw);
    return { inventory, evidence: inventory ? { filter: inventory.filter, matchedCount: inventory.matchedCount,
      shown: inventory.processes?.length ?? null, unknown: inventory.processes?.filter(item => item.kind === "unknown").length ?? null } : { status: "unverified" } };
  } catch { return { inventory: null, evidence: { status: "unavailable" } }; }
}
function processIdentity(pid, contract) {
  try {
    const state = (contract.processIdentity ?? windows_process_identity)(pid);
    if (!state || state.pid !== pid || typeof state.executable !== "string" || !/(?:^|[\\/])1cv8c?\.exe$/i.test(state.executable) ||
        typeof state.created !== "string" || !/^win32-filetime:\d+$/.test(state.created)) return null;
    return { pid, created: state.created };
  } catch { return null; }
}
function processBinding(profile, process, identity, contract) {
  try {
    const binding = (contract.processBinding ?? windows_testclient_binding)(profile.mcp.port, process.pid, process.launch.testPort, identity.created);
    return Number.isInteger(binding?.managerPid) && binding.managerPid > 0 && binding.managerPid !== process.pid &&
      typeof binding.managerCreated === "string" && /^win32-filetime:\d+$/.test(binding.managerCreated) ? binding : null;
  } catch { return null; }
}
function clientAuthMatches(parameters, expectedUser) {
  if (expectedUser === undefined) return true;
  const tokens = platformTokens(parameters), users = [];
  if (tokens) for (let i = 0; i < tokens.length; i++) if (/^\/N/i.test(tokens[i])) users.push(tokens[i].length === 2 ? tokens[++i] : tokens[i].slice(2));
  return Boolean(tokens && users.length === 1 && users[0] === expectedUser);
}
function sameConnectedProfile(profile, before, profiles, pid, requirePid) {
  if (!Array.isArray(profiles) || profiles.some(item => typeof item.connected !== "boolean")) return false;
  const connected = profiles.filter(item => item.connected), matches = profiles.filter(item => item.name === profile.client.name);
  if (connected.length !== 1 || matches.length !== 1 || connected[0] !== matches[0]) return false;
  const after = matches[0];
  return sameInfobase(profile.client.infobase, after.infobase) && after.computerName === before.computerName &&
    after.additionalParameters === before.additionalParameters && after.pid === before.pid &&
    (!requirePid || after.pid === pid) && (!(Number.isInteger(after.pid) && after.pid > 0) || after.pid === pid);
}

export async function inspectSession(profile, client, tools, contract = runtimeContract, { connecting = false, allowMissingProfile = false, repairComputer = false, ownRecording = false } = {}) {
  if (!isLocalComputer(profile.client.computerName)) return error("client_computer_is_not_verified_local");
  const missing = requiredTools.filter(name => !tools.some(tool => tool.name === name));
  if (missing.length) return { status: "error", reason: "required_tools_missing", missing };
  const evidence = {
    environment: await callTool(client, tools, "get_environment_data", {}),
    state: await callTool(client, tools, "get_vanessa_automation_state", {}),
    profiles: await callTool(client, tools, "manage_test_client_profiles", { action: "get_list" }),
    editor: await callTool(client, tools, "get_editor_state", { includeContent: false }),
  };
  const environment = contract.environment(evidence.environment);
  if (!environment) return unverified("environment_response_contract_unverified", evidence);
  if (!sameInfobase(profile.manager.infobase, environment.managerInfobase)) return error("manager_infobase_mismatch");
  if (environment.vanessaExt !== true || typeof environment.runtimeVersion !== "string" || !environment.runtimeVersion) return unverified("manager_components_unverified", evidence);
  const editor = contract.editor?.(evidence.editor);
  if (editor?.stateAvailable !== true) return unverified("editor_response_contract_unverified", evidence);
  const profiles = contract.profiles(evidence.profiles);
  if (!Array.isArray(profiles)) return unverified("client_profiles_response_contract_unverified", evidence);
  const state = contract.state(evidence.state);
  if (!state || typeof state.connected !== "boolean" || typeof state.running !== "boolean" || typeof state.recording !== "boolean") return unverified("session_state_response_contract_unverified", evidence);
  if (state.recording === false) invalidateObservedIdle(profile, environment.runtimeVersion);
  if (state.running || (state.recording && !ownRecording)) return error("session_busy_with_scenario_or_recording");
  // The manager's session identity is not present in the environment response.
  if (configuredUser(profile.manager, "manager") !== undefined) return unverified("manager_session_user_unverified", evidence);
  const expectedUser = configuredUser(profile.client, "client");
  const matches = profiles.filter(item => item.name === profile.client.name);
  if (!matches.length && allowMissingProfile && !state.connected && !state.recording)
    return expectedUser !== undefined ? unverified("actual_test_client_user_unverified", evidence) : { status: "profile_missing" };
  if (matches.length !== 1 || !sameInfobase(profile.client.infobase, matches[0].infobase)) return error("client_profile_mismatch_or_ambiguous");
  if (!taxiCompatible(matches[0].additionalParameters)) return error("client_interface_mismatch_or_unverified");
  if (!clientAuthMatches(matches[0].additionalParameters, expectedUser)) return error("client_authentication_profile_mismatch");
  if (matches[0].computerName !== profile.client.computerName) {
    if (repairComputer && !state.recording && (!state.connected || state.clientName === profile.client.name))
      return expectedUser !== undefined ? unverified("actual_test_client_user_unverified", evidence) : { status: "computer_name_mismatch" };
    return error("client_computer_name_mismatch_or_unverified");
  }
  if (!state.connected) return expectedUser !== undefined ? unverified("actual_test_client_user_unverified", evidence) : connecting ? { status: "connectable", runtimeVersion: environment.runtimeVersion } : error("test_client_disconnected");
  const connectedProfiles = profiles.filter(item => item.connected === true);
  const clientName = state.clientName ?? (connectedProfiles.length === 1 ? connectedProfiles[0].name : null);
  if (profiles.some(item => typeof item.connected !== "boolean") || clientName !== profile.client.name || connectedProfiles.length !== 1 || connectedProfiles[0].name !== profile.client.name) return unverified("connected_client_identity_mismatch_or_unverified", evidence);
  const observation = await processInventory(client, tools, contract), inventory = observation.inventory;
  evidence.processes = observation.evidence;
  const selected = selectedProcess(profile, profiles, inventory);
  if (!selected) return unverified("unique_actual_test_client_process_not_verified", evidence);
  const clientProcess = selected.process, identitySource = selected.source;
  if (!clientProcess.launch || !Number.isInteger(clientProcess.pid) || clientProcess.pid < 1 || !sameInfobase(profile.client.infobase, clientProcess.launch.infobase) || clientProcess.launch.interface !== "taxi") return unverified("actual_test_client_launch_mismatch_or_unverified", evidence);
  if (expectedUser !== undefined && clientProcess.launch.user !== expectedUser) return error("actual_test_client_user_mismatch");
  // /N is a launch preference. OS or interactive authentication may select a
  // different user, and the supported MCP responses do not prove the session's
  // authenticated identity. Do not run user-scoped tests with that uncertainty.
  if (expectedUser !== undefined) return unverified("actual_test_client_user_unverified", evidence);
  const identity = processIdentity(clientProcess.pid, contract);
  if (!identity) return unverified("actual_test_client_process_identity_unverified", evidence);
  const binding = processBinding(profile, clientProcess, identity, contract);
  if (!binding) return unverified("manager_test_client_connection_unverified", evidence);
  evidence.extensions = await callTool(client, tools, "get_extension_list", {});
  const extensions = contract.extensions(evidence.extensions);
  if (!Array.isArray(extensions)) return unverified("extensions_response_contract_unverified", evidence);
  const extension = extensions.filter(item => item.name === "VAExtension");
  if (extension.length !== 1 || extension[0].active !== true || typeof extension[0].version !== "string" || !extension[0].version) return error("active_vaextension_not_verified");
  // These are separate MCP calls, so do not accept a profile snapshot obtained
  // before an external switch during process or extension discovery.
  evidence.finalState = await callTool(client, tools, "get_vanessa_automation_state", {});
  evidence.finalProfiles = await callTool(client, tools, "manage_test_client_profiles", { action: "get_list" });
  const finalState = contract.state(evidence.finalState), finalProfiles = contract.profiles(evidence.finalProfiles);
  if (!finalState || finalState.connected !== true || finalState.running !== false || finalState.recording !== state.recording ||
      (finalState.clientName ?? profile.client.name) !== profile.client.name ||
      !sameConnectedProfile(profile, connectedProfiles[0], finalProfiles, clientProcess.pid, selected.requirePid) ||
      processIdentity(clientProcess.pid, contract)?.created !== identity.created ||
      !sameBinding(binding, processBinding(profile, clientProcess, identity, contract))) return unverified("session_changed_during_readiness", evidence);
  return { status: "ready", readinessScope: "environment_and_test_client", toolCount: tools.length, runtimeVersion: environment.runtimeVersion,
    runtime: { vanessa: environment.runtimeVersion, mcp: environment.mcpVersion ?? null, platform: environment.platformVersion ?? null },
    responseContract: contract.version, testClient: profile.client.name, vaExtensionVersion: extension[0].version, recording: state.recording, editorErrorCount: editor.errorCount, editorEnabled: "unverified",
    clientProcess: { pid: clientProcess.pid, created: identity.created, startedAt: clientProcess.startedAt, testPort: clientProcess.launch.testPort, identitySource },
    managerProcess: binding };
}

function sameBinding(first, second) { return Boolean(first && second && first.managerPid === second.managerPid && first.managerCreated === second.managerCreated); }

// Recheck client identity and idle state after a user handoff and before execution.
// An abbreviated editor-only state cannot prove that the manager is idle.
export async function confirmClientBinding(profile, client, tools, baseline, contract = runtimeContract) {
  const evidence = { profiles: await callTool(client, tools, "manage_test_client_profiles", { action: "get_list" }) };
  const profiles = contract.profiles(evidence.profiles);
  if (!Array.isArray(profiles)) return unverified("client_binding_changed_or_unverified", evidence);
  const observation = await processInventory(client, tools, contract), inventory = observation.inventory;
  evidence.processes = observation.evidence;
  const selected = selectedProcess(profile, profiles, inventory);
  const process = selected?.process, expectedUser = configuredUser(profile.client, "client");
  const before = profiles.find(item => item.name === profile.client.name);
  const identity = process && processIdentity(process.pid, contract);
  if (!process || !before || !identity || !baseline.clientProcess?.created || process.pid !== baseline.clientProcess?.pid || identity.created !== baseline.clientProcess.created ||
      !process.launch || process.launch.testPort !== baseline.clientProcess?.testPort || process.launch.interface !== "taxi" ||
      !sameInfobase(profile.client.infobase, process.launch.infobase) || (expectedUser !== undefined && process.launch.user !== expectedUser) ||
      !taxiCompatible(before.additionalParameters) || !clientAuthMatches(before.additionalParameters, expectedUser) ||
      before.computerName !== profile.client.computerName) return unverified("client_binding_changed_or_unverified", evidence);
  if (!sameBinding(baseline.managerProcess, processBinding(profile, process, identity, contract))) return unverified("manager_test_client_connection_unverified", evidence);
  evidence.finalProfiles = await callTool(client, tools, "manage_test_client_profiles", { action: "get_list" });
  if (!sameConnectedProfile(profile, before, contract.profiles(evidence.finalProfiles), process.pid, selected.requirePid)) return unverified("client_binding_changed_or_unverified", evidence);
  evidence.state = await callTool(client, tools, "get_vanessa_automation_state", {});
  const state = contract.state(evidence.state);
  if (!state || typeof state.connected !== "boolean" || typeof state.running !== "boolean" || typeof state.recording !== "boolean") return unverified("session_state_response_contract_unverified", evidence);
  if (state.running || state.recording) return unverified("session_busy_with_scenario_or_recording", evidence);
  if (!state.connected || (state.clientName ?? profile.client.name) !== profile.client.name ||
      processIdentity(process.pid, contract)?.created !== baseline.clientProcess?.created ||
      !sameBinding(baseline.managerProcess, processBinding(profile, process, identity, contract))) return unverified("client_binding_changed_or_unverified", evidence);
  return { status: "confirmed" };
}

export async function connectSession(profile, client, tools, contract = runtimeContract) {
  const before = await inspectSession(profile, client, tools, contract, { connecting: true });
  return connectVerified(profile, client, tools, contract, before);
}
async function connectVerified(profile, client, tools, contract, before) {
  if (before.status !== "connectable") return before;
  let dispatched = false;
  try {
    await callTool(client, tools, "manage_test_client", { action: "connect", profileName: profile.client.name }, { onDispatch: () => { dispatched = true; } });
  } catch (failure) {
    if (failure.code === "tool_error" || !dispatched) throw failure;
    const uncertain = new Error("Исход подключения TestClient неизвестен; перед повтором проверьте состояние");
    uncertain.code = "mutation_indeterminate";
    uncertain.detail = { classification: "transport_or_protocol", outcome: "indeterminate", tool: "manage_test_client", nextAction: uncertain.message };
    throw uncertain;
  }
  return inspectSession(profile, client, tools, contract);
}

export async function setupSession(profile, client, tools, contract = runtimeContract) {
  const before = await inspectSession(profile, client, tools, contract, { connecting: true, allowMissingProfile: true, repairComputer: true });
  if (before.status === "profile_missing") {
    let dispatched = false;
    try {
      await callTool(client, tools, "manage_test_client_profiles", { action: "add", name: profile.client.name, infobase_path: connectionString(profile.client.infobase), additional_parameters: clientAdditionalParameters(profile), computer_name: profile.client.computerName }, { onDispatch: () => { dispatched = true; } });
    } catch (failure) {
      if (failure.code === "tool_error" || !dispatched) throw failure;
      const uncertain = new Error("Исход создания профиля TestClient неизвестен; перед повтором проверьте профили");
      uncertain.code = "mutation_indeterminate";
      uncertain.detail = { classification: "transport_or_protocol", outcome: "indeterminate", tool: "manage_test_client_profiles", nextAction: uncertain.message };
      throw uncertain;
    }
    return connectSession(profile, client, tools, contract);
  }
  if (before.status === "computer_name_mismatch") {
    let dispatched = false;
    try {
      await callTool(client, tools, "manage_test_client_profiles", { action: "edit", name: profile.client.name, computer_name: profile.client.computerName }, { onDispatch: () => { dispatched = true; } });
    } catch (failure) {
      if (failure.code === "tool_error" || !dispatched) throw failure;
      const uncertain = new Error("Исход изменения профиля TestClient неизвестен; перед повтором проверьте профиль");
      uncertain.code = "mutation_indeterminate"; uncertain.detail = { classification: "transport_or_protocol", outcome: "indeterminate", tool: "manage_test_client_profiles", nextAction: uncertain.message }; throw uncertain;
    }
    return connectSession(profile, client, tools, contract);
  }
  return connectVerified(profile, client, tools, contract, before);
}
