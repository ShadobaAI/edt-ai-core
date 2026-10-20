import path from "node:path";
import os from "node:os";
import { callTool } from "./mcp.mjs";
import { connectionString, clientAdditionalParameters } from "./profile.mjs";
import { invalidateObservedIdle } from "./recording.mjs";
import { runtimeContract } from "./runtime-contract.mjs";
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
    if (typeof actual.path !== "string" || !path.isAbsolute(actual.path)) return false;
    const normalize = file => { const resolved = path.resolve(file).replace(/[\\/]+$/, ""); return process.platform === "win32" ? resolved.toLowerCase() : resolved; };
    return normalize(expected.path) === normalize(actual.path);
  }
  return typeof actual.server === "string" && actual.server.toLowerCase() === expected.server.toLowerCase() && actual.database === expected.database;
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
  const matches = profiles.filter(item => item.name === profile.client.name);
  if (!matches.length && allowMissingProfile && !state.connected && !state.recording) return { status: "profile_missing" };
  if (matches.length !== 1 || !sameInfobase(profile.client.infobase, matches[0].infobase)) return error("client_profile_mismatch_or_ambiguous");
  if (!taxiCompatible(matches[0].additionalParameters)) return error("client_interface_mismatch_or_unverified");
  if (profile.client.userEnv) {
    const expectedAuth = clientAdditionalParameters(profile).slice("/iTaxi ".length);
    if (!matches[0].additionalParameters.split(/\s+(?=\/)/).includes(expectedAuth)) return error("client_authentication_profile_mismatch");
  }
  if (matches[0].computerName !== profile.client.computerName) {
    if (repairComputer && !state.recording && (!state.connected || state.clientName === profile.client.name)) return { status: "computer_name_mismatch" };
    return error("client_computer_name_mismatch_or_unverified");
  }
  if (!state.connected) return connecting ? { status: "connectable", runtimeVersion: environment.runtimeVersion } : error("test_client_disconnected");
  const connectedProfiles = profiles.filter(item => item.connected === true);
  const clientName = state.clientName ?? (connectedProfiles.length === 1 ? connectedProfiles[0].name : null);
  if (clientName !== profile.client.name || connectedProfiles.length !== 1 || connectedProfiles[0].name !== profile.client.name) return unverified("connected_client_identity_mismatch_or_unverified", evidence);
  evidence.processes = await callTool(client, tools, "get_process_list_os", { only_1c: true, filter: "/TESTCLIENT", limit: 20 });
  const inventory = contract.processes?.(evidence.processes);
  if (!inventory || inventory.filter !== "/TESTCLIENT" || inventory.matchedCount !== 1 || inventory.processes.length !== 1) return unverified("unique_actual_test_client_process_not_verified", evidence);
  const clientProcess = inventory.processes[0];
  if (!clientProcess.launch || !Number.isInteger(clientProcess.pid) || clientProcess.pid < 1 || !clientProcess.startedAt || !sameInfobase(profile.client.infobase, clientProcess.launch.infobase) || clientProcess.launch.interface !== "taxi") return unverified("actual_test_client_launch_mismatch_or_unverified", evidence);
  if (profile.client.userEnv && clientProcess.launch.user !== process.env[profile.client.userEnv]) return error("actual_test_client_user_mismatch");
  evidence.extensions = await callTool(client, tools, "get_extension_list", {});
  const extensions = contract.extensions(evidence.extensions);
  if (!Array.isArray(extensions)) return unverified("extensions_response_contract_unverified", evidence);
  const extension = extensions.filter(item => item.name === "VAExtension");
  if (extension.length !== 1 || extension[0].active !== true || typeof extension[0].version !== "string" || !extension[0].version) return error("active_vaextension_not_verified");
  return { status: "ready", readinessScope: "environment_and_test_client", toolCount: tools.length, runtimeVersion: environment.runtimeVersion,
    runtime: { vanessa: environment.runtimeVersion, mcp: environment.mcpVersion ?? null, platform: environment.platformVersion ?? null },
    responseContract: contract.version, testClient: profile.client.name, vaExtensionVersion: extension[0].version, recording: state.recording, editorErrorCount: editor.errorCount, editorEnabled: "unverified",
    clientProcess: { pid: clientProcess.pid, startedAt: clientProcess.startedAt, testPort: clientProcess.launch.testPort, identitySource: "unique_global_os_testclient" } };
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
    const uncertain = new Error("TestClient connection outcome is indeterminate; inspect state before retrying");
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
      const uncertain = new Error("TestClient profile creation outcome is indeterminate; inspect profiles before retrying");
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
      const uncertain = new Error("TestClient profile edit outcome is indeterminate; inspect profile before retrying");
      uncertain.code = "mutation_indeterminate"; uncertain.detail = { classification: "transport_or_protocol", outcome: "indeterminate", tool: "manage_test_client_profiles", nextAction: uncertain.message }; throw uncertain;
    }
    return connectSession(profile, client, tools, contract);
  }
  return connectVerified(profile, client, tools, contract, before);
}
