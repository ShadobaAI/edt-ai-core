import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { path_identity } from "../scripts/project_paths.mjs";
import { casefold } from "../scripts/casefold.mjs";
import { windows_process_identity, windows_testclient_binding } from "../scripts/windows_process.mjs";
import { callTool, redact } from "./mcp.mjs";
import { invalidateObservedIdle } from "./recording.mjs";
import { runtimeContract, platformTokens } from "./runtime-contract.mjs";
import { connectionString, fail } from "./profile.mjs";
export { runtimeContract } from "./runtime-contract.mjs";

// Runtime-specific parsers are deliberately separate from orchestration. They must be
// established from actual runtime responses before their fields can assert readiness.
export const requiredTools = ["get_environment_data", "get_vanessa_automation_state", "get_editor_state", "manage_test_client_profiles", "manage_test_client", "get_extension_list", "get_process_list_os", "open_feature_file", "check_syntax", "get_test_results", "get_window_list_os"];
const unverified = (reason, evidence) => ({ status: "unverified", reason, evidence });
const error = reason => ({ status: "error", reason });
const connectedProfileSnapshot = Symbol("connected-profile-snapshot");
const disconnectedProfileSnapshot = Symbol("disconnected-profile-snapshot");
const profileEvidence = profiles => Array.isArray(profiles) ? { status: "parsed", count: profiles.length } : { status: "unverified" };
const folded = text => casefold(text.normalize("NFC")).normalize("NFC");
function namedProfiles(profiles, name) {
  if (!Array.isArray(profiles) || typeof name !== "string") return null;
  if (profiles.some(item => typeof item.name !== "string" || item.synonym !== undefined && typeof item.synonym !== "string")) return null;
  const key = folded(name);
  return profiles.filter(item => folded(item.name) === key || typeof item.synonym === "string" && folded(item.synonym) === key);
}
function uniqueNamedProfile(profiles, name) {
  const matches = namedProfiles(profiles, name);
  return matches?.length === 1 && matches[0].name === name ? matches[0] : null;
}
export function isLocalComputer(value) {
  return typeof value === "string" && ["localhost", "127.0.0.1", "::1", os.hostname().toLowerCase()].includes(value.toLowerCase());
}
export function taxiCompatible(parameters) {
  if (typeof parameters !== "string") return false;
  const tokens = platformTokens(parameters);
  return Boolean(tokens && tokens.some(token => /^\/itaxi$/i.test(token)) && !tokens.some(token => /^\/itdi$/i.test(token)));
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
async function processBinding(profile, process, identity, contract) {
  try {
    const binding = await (contract.processBinding ?? windows_testclient_binding)(profile.mcp.port, process.pid, process.launch.testPort, identity.created);
    return Number.isInteger(binding?.managerPid) && binding.managerPid > 0 && binding.managerPid !== process.pid &&
      typeof binding.managerCreated === "string" && /^win32-filetime:\d+$/.test(binding.managerCreated) ? binding : null;
  } catch { return null; }
}
function sameConnectedProfile(profile, before, profiles, pid, requirePid) {
  if (!Array.isArray(profiles) || profiles.some(item => typeof item.connected !== "boolean")) return false;
  const connected = profiles.filter(item => item.connected), after = uniqueNamedProfile(profiles, profile.client.name);
  if (connected.length !== 1 || !after || connected[0] !== after) return false;
  return sameProfileConfiguration(profile, before, after) &&
    (!requirePid || after.pid === pid) && (!(Number.isInteger(after.pid) && after.pid > 0) || after.pid === pid);
}
function sameProfileConfiguration(profile, before, after) {
  return Boolean(before && after && after.name === before.name && after.synonym === before.synonym &&
    sameInfobase(profile.client.infobase, after.infobase) && after.connectionFingerprint === before.connectionFingerprint &&
    after.additionalParameters === before.additionalParameters && after.clientType === before.clientType && after.computerName === before.computerName && after.pid === before.pid);
}

export async function inspectSession(profile, client, tools, contract = runtimeContract, { connecting = false, ownRecording = false } = {}) {
  if (!isLocalComputer(profile.client.computerName)) return error("client_computer_is_not_verified_local");
  const missing = requiredTools.filter(name => !tools.some(tool => tool.name === name));
  if (missing.length) return { status: "error", reason: "required_tools_missing", missing };
  const raw = {
    environment: await callTool(client, tools, "get_environment_data", {}),
    state: await callTool(client, tools, "get_vanessa_automation_state", {}),
    profiles: await callTool(client, tools, "manage_test_client_profiles", { action: "get_list" }),
    editor: await callTool(client, tools, "get_editor_state", { includeContent: false }),
  };
  // Vanessa owns credentials, and get_list can return them. Keep raw responses
  // local to validation; no readiness or failure evidence may expose them.
  const evidence = { environment: redact(raw.environment), state: redact(raw.state), profiles: { status: "omitted" }, editor: redact(raw.editor) };
  const environment = contract.environment(raw.environment);
  if (!environment) return unverified("environment_response_contract_unverified", evidence);
  if (!sameInfobase(profile.manager.infobase, environment.managerInfobase)) return error("manager_infobase_mismatch");
  if (environment.vanessaExt !== true || typeof environment.runtimeVersion !== "string" || !environment.runtimeVersion) return unverified("manager_components_unverified", evidence);
  const editor = contract.editor?.(raw.editor);
  if (editor?.stateAvailable !== true) return unverified("editor_response_contract_unverified", evidence);
  const profiles = contract.profiles(raw.profiles);
  evidence.profiles = profileEvidence(profiles);
  if (!Array.isArray(profiles)) return unverified("client_profiles_response_contract_unverified", evidence);
  const state = contract.state(raw.state);
  if (!state || typeof state.connected !== "boolean" || typeof state.running !== "boolean" || typeof state.recording !== "boolean") return unverified("session_state_response_contract_unverified", evidence);
  if (state.recording === false) invalidateObservedIdle(profile, environment.runtimeVersion);
  if (state.running || (state.recording && !ownRecording)) return error("session_busy_with_scenario_or_recording");
  const matchedProfile = uniqueNamedProfile(profiles, profile.client.name);
  if (!matchedProfile || !sameInfobase(profile.client.infobase, matchedProfile.infobase)) return error("client_profile_mismatch_or_ambiguous");
  if (!["Тонкий", "Толстый"].includes(matchedProfile.clientType)) return error("client_type_mismatch_or_unverified");
  if (!taxiCompatible(matchedProfile.additionalParameters)) return error("client_interface_mismatch_or_unverified");
  if (matchedProfile.computerName !== profile.client.computerName) {
    return error("client_computer_name_mismatch_or_unverified");
  }
  if (!state.connected) {
    // Upstream connect may disconnect the active client first. A stale or
    // ambiguous profile list cannot authorize that side effect.
    if (profiles.some(item => item.connected !== false)) return unverified("client_connection_state_conflict", evidence);
    if (!connecting) return error("test_client_disconnected");
    const result = { status: "connectable", runtimeVersion: environment.runtimeVersion };
    Object.defineProperty(result, disconnectedProfileSnapshot, { value: matchedProfile });
    return result;
  }
  const connectedProfiles = profiles.filter(item => item.connected === true);
  const clientName = state.clientName ?? (connectedProfiles.length === 1 ? connectedProfiles[0].name : null);
  if (profiles.some(item => typeof item.connected !== "boolean") || clientName !== profile.client.name || connectedProfiles.length !== 1 || connectedProfiles[0].name !== profile.client.name) return unverified("connected_client_identity_mismatch_or_unverified", evidence);
  const observation = await processInventory(client, tools, contract), inventory = observation.inventory;
  evidence.processes = observation.evidence;
  const selected = selectedProcess(profile, profiles, inventory);
  if (!selected) return unverified("unique_actual_test_client_process_not_verified", evidence);
  const clientProcess = selected.process, identitySource = selected.source;
  if (!clientProcess.launch || !Number.isInteger(clientProcess.pid) || clientProcess.pid < 1 || !sameInfobase(profile.client.infobase, clientProcess.launch.infobase) || clientProcess.launch.interface !== "taxi") return unverified("actual_test_client_launch_mismatch_or_unverified", evidence);
  const identity = processIdentity(clientProcess.pid, contract);
  if (!identity) return unverified("actual_test_client_process_identity_unverified", evidence);
  const binding = await processBinding(profile, clientProcess, identity, contract);
  if (!binding) return unverified("manager_test_client_connection_unverified", evidence);
  const extensionResponse = await callTool(client, tools, "get_extension_list", {});
  evidence.extensions = redact(extensionResponse);
  const extensions = contract.extensions(extensionResponse);
  if (!Array.isArray(extensions)) return unverified("extensions_response_contract_unverified", evidence);
  const extension = extensions.filter(item => item.name === "VAExtension");
  if (extension.length !== 1 || extension[0].active !== true || typeof extension[0].version !== "string" || !extension[0].version) return error("active_vaextension_not_verified");
  // These are separate MCP calls, so do not accept a profile snapshot obtained
  // before an external switch during process or extension discovery.
  const finalStateResponse = await callTool(client, tools, "get_vanessa_automation_state", {});
  const finalProfilesResponse = await callTool(client, tools, "manage_test_client_profiles", { action: "get_list" });
  evidence.finalState = redact(finalStateResponse);
  const finalState = contract.state(finalStateResponse), finalProfiles = contract.profiles(finalProfilesResponse);
  evidence.finalProfiles = profileEvidence(finalProfiles);
  if (!finalState || finalState.connected !== true || finalState.running !== false || finalState.recording !== state.recording ||
      (finalState.clientName ?? profile.client.name) !== profile.client.name ||
      !sameConnectedProfile(profile, connectedProfiles[0], finalProfiles, clientProcess.pid, selected.requirePid) ||
      processIdentity(clientProcess.pid, contract)?.created !== identity.created ||
      !sameBinding(binding, await processBinding(profile, clientProcess, identity, contract))) return unverified("session_changed_during_readiness", evidence);
  const result = { status: "ready", readinessScope: "environment_and_test_client", toolCount: tools.length, runtimeVersion: environment.runtimeVersion,
    runtime: { vanessa: environment.runtimeVersion, mcp: environment.mcpVersion ?? null, platform: environment.platformVersion ?? null },
    responseContract: contract.version, testClient: profile.client.name, authenticatedUser: "unverified", vaExtensionVersion: extension[0].version, recording: state.recording, editorErrorCount: editor.errorCount, editorEnabled: "unverified",
    clientProcess: { pid: clientProcess.pid, created: identity.created, startedAt: clientProcess.startedAt, testPort: clientProcess.launch.testPort, identitySource },
    managerProcess: binding };
  Object.defineProperty(result, connectedProfileSnapshot, { value: connectedProfiles[0] });
  return result;
}

function sameBinding(first, second) { return Boolean(first && second && first.managerPid === second.managerPid && first.managerCreated === second.managerCreated); }

// Recheck client identity and idle state after a user handoff and before execution.
// An abbreviated editor-only state cannot prove that the manager is idle.
export async function confirmClientBinding(profile, client, tools, baseline, contract = runtimeContract) {
  const profileResponse = await callTool(client, tools, "manage_test_client_profiles", { action: "get_list" });
  const profiles = contract.profiles(profileResponse);
  const evidence = { profiles: profileEvidence(profiles) };
  if (!Array.isArray(profiles)) return unverified("client_binding_changed_or_unverified", evidence);
  const observation = await processInventory(client, tools, contract), inventory = observation.inventory;
  evidence.processes = observation.evidence;
  const selected = selectedProcess(profile, profiles, inventory);
  const process = selected?.process;
  const before = uniqueNamedProfile(profiles, profile.client.name), baselineProfile = baseline[connectedProfileSnapshot];
  const identity = process && processIdentity(process.pid, contract);
  if (!process || !before || !identity || !baseline.clientProcess?.created || process.pid !== baseline.clientProcess?.pid || identity.created !== baseline.clientProcess.created ||
      !process.launch || process.launch.testPort !== baseline.clientProcess?.testPort || process.launch.interface !== "taxi" ||
      !sameInfobase(profile.client.infobase, process.launch.infobase) || !taxiCompatible(before.additionalParameters) ||
      before.computerName !== profile.client.computerName || !baselineProfile ||
      !sameConnectedProfile(profile, baselineProfile, profiles, process.pid, selected.requirePid)) return unverified("client_binding_changed_or_unverified", evidence);
  if (!sameBinding(baseline.managerProcess, await processBinding(profile, process, identity, contract))) return unverified("manager_test_client_connection_unverified", evidence);
  const finalProfilesResponse = await callTool(client, tools, "manage_test_client_profiles", { action: "get_list" });
  const finalProfiles = contract.profiles(finalProfilesResponse);
  evidence.finalProfiles = profileEvidence(finalProfiles);
  if (!sameConnectedProfile(profile, before, finalProfiles, process.pid, selected.requirePid)) return unverified("client_binding_changed_or_unverified", evidence);
  const stateResponse = await callTool(client, tools, "get_vanessa_automation_state", {});
  evidence.state = redact(stateResponse);
  const state = contract.state(stateResponse);
  if (!state || typeof state.connected !== "boolean" || typeof state.running !== "boolean" || typeof state.recording !== "boolean") return unverified("session_state_response_contract_unverified", evidence);
  if (state.running || state.recording) return unverified("session_busy_with_scenario_or_recording", evidence);
  if (!state.connected || (state.clientName ?? profile.client.name) !== profile.client.name ||
      processIdentity(process.pid, contract)?.created !== baseline.clientProcess?.created ||
      !sameBinding(baseline.managerProcess, await processBinding(profile, process, identity, contract))) return unverified("client_binding_changed_or_unverified", evidence);
  return { status: "confirmed" };
}

export async function connectSession(profile, client, tools, contract = runtimeContract, { onMutation = () => {} } = {}) {
  const before = await inspectSession(profile, client, tools, contract, { connecting: true });
  return connectVerified(profile, client, tools, contract, before, onMutation);
}
async function connectVerified(profile, client, tools, contract, before, onMutation) {
  if (before.status !== "connectable") return before;
  const stateResponse = await callTool(client, tools, "get_vanessa_automation_state", {});
  const profileResponse = await callTool(client, tools, "manage_test_client_profiles", { action: "get_list" });
  const state = contract.state(stateResponse), profiles = contract.profiles(profileResponse);
  const selected = uniqueNamedProfile(profiles, profile.client.name);
  if (!state || state.connected !== false || state.running !== false || state.recording !== false || !Array.isArray(profiles) ||
      profiles.some(item => item.connected !== false) || !sameProfileConfiguration(profile, before[disconnectedProfileSnapshot], selected)) {
    return unverified("client_binding_changed_or_unverified", { state: redact(stateResponse), profiles: profileEvidence(profiles) });
  }
  let dispatched = false;
  try {
    await callTool(client, tools, "manage_test_client", { action: "connect", profileName: profile.client.name }, { onDispatch: () => { dispatched = true; onMutation("manage_test_client", true); } });
    onMutation("manage_test_client", false);
  } catch (failure) {
    if (failure.code === "tool_error") onMutation("manage_test_client", false);
    if (failure.code === "tool_error" || !dispatched) throw failure;
    const uncertain = new Error("Исход подключения TestClient неизвестен; перед повтором проверьте состояние");
    uncertain.code = "mutation_indeterminate";
    uncertain.detail = { classification: "transport_or_protocol", outcome: "indeterminate", tool: "manage_test_client", nextAction: uncertain.message };
    throw uncertain;
  }
  return inspectSession(profile, client, tools, contract);
}

export async function setupSession(profile, client, tools, contract = runtimeContract, { onMutation = () => {}, verifyManager = () => false } = {}) {
  return setupManagedProfile(profile, client, tools, contract, onMutation, verifyManager);
}

async function setupManagedProfile(profile, client, tools, contract, onMutation, verifyManager) {
  if (!isLocalComputer(profile.client.computerName)) return error("client_computer_is_not_verified_local");
  if (requiredTools.some(name => !tools.some(tool => tool.name === name))) return error("required_tools_missing");
  const managerVerified = async () => { try { return await verifyManager() === true; } catch { return false; } };
  if (!await managerVerified()) return unverified("manager_binding_unverified");
  const observe = async () => {
    const environment = contract.environment(await callTool(client, tools, "get_environment_data", {}));
    const state = contract.state(await callTool(client, tools, "get_vanessa_automation_state", {}));
    const profiles = contract.profiles(await callTool(client, tools, "manage_test_client_profiles", { action: "get_list" }));
    const editor = contract.editor?.(await callTool(client, tools, "get_editor_state", { includeContent: false }));
    if (!environment || !sameInfobase(profile.manager.infobase, environment.managerInfobase) || environment.vanessaExt !== true || !environment.runtimeVersion ||
        !state || state.connected !== false || state.running !== false || state.recording !== false || editor?.stateAvailable !== true ||
        !Array.isArray(profiles) || profiles.some(item => item.connected !== false)) return null;
    const matches = namedProfiles(profiles, profile.client.name);
    if (!matches || matches.length > 1 || (matches.length === 1 && matches[0].name !== profile.client.name)) return null;
    return matches.length ? { existing: true, snapshot: matches[0] } : { existing: false };
  };
  const first = await observe();
  if (!first) return error("client_profile_setup_state_unverified");
  const second = await observe();
  if (!second || first.existing !== second.existing || JSON.stringify(first.snapshot) !== JSON.stringify(second.snapshot)) return unverified("client_profile_changed_during_setup");
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  const { user } = profile.client;
  const clientInterface = user.interface === "taxi" ? "/iTaxi" : fail("Неподдерживаемый интерфейс клиента");
  const args = { action: first.existing ? "edit" : "add", name: profile.client.name, infobase_path: connectionString(profile.client.infobase),
    additional_parameters: `${clientInterface} /N${quote(user.name)} /P${quote(user.password)}`, client_type: "Тонкий", computer_name: profile.client.computerName };
  if (!await managerVerified()) return unverified("manager_binding_unverified");
  let dispatched = false;
  try {
    await callTool(client, tools, "manage_test_client_profiles", args, { onDispatch: () => { dispatched = true; onMutation("manage_test_client_profiles", true); } });
    onMutation("manage_test_client_profiles", false);
  } catch (failure) {
    if (failure.code === "tool_error") onMutation("manage_test_client_profiles", false);
    if (failure.code === "tool_error" || !dispatched) throw failure;
    const uncertain = new Error("Исход изменения профиля клиента неизвестен; проверьте состояние Vanessa перед повтором");
    uncertain.code = "mutation_indeterminate";
    throw uncertain;
  }
  return connectSession(profile, client, tools, contract, { onMutation });
}
