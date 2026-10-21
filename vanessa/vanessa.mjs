import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile, readJson, checkFiles, configSnippet, interactiveParameters, digest, fail } from "./profile.mjs";
import { session, listTools, callTool, redact } from "./mcp.mjs";
import { withProfileLock, checkOwner, managerAlive, start } from "./runtime.mjs";
import { inspectSession, connectSession, setupSession } from "./readiness.mjs";
import { ownRecording, recordOwnership, invalidateObservedIdle } from "./recording.mjs";
import { runFeature } from "./run.mjs";
import { awaitEditorTransition } from "./transition.mjs";
import { saveRunReceipt } from "./receipt.mjs";
export { loadProfile } from "./profile.mjs";

export const discoveryTools = new Set(["get_environment_data", "get_vanessa_automation_state", "get_editor_state", "get_test_results", "get_window_list_os", "get_extension_list", "get_process_list_os"]);
const isDiscovery = (name, args) => discoveryTools.has(name) || (name === "manage_test_client_profiles" && args.action === "get_list");
export async function probeReadiness(profile, client, tools) {
  return inspectSession(profile, client, tools);
}

export async function doctor(profile) {
  checkFiles(profile);
  return withProfileLock(profile, async () => {
    checkOwner(profile);
    const result = await session(profile, async client => probeReadiness(profile, client, await listTools(client)));
    if (result.status === "ready" && result.recording === false) invalidateObservedIdle(profile, result.runtimeVersion);
    return redact(result);
  });
}

export async function main(argv) {
  const command = argv.shift();
  if (!command || command === "help" || command === "--help") return { usage: "node vanessa.mjs <configure|start|setup|connect|doctor|list|call|run> --profile <file> [--tool <actual-name> --arguments-file <json>] [--feature <file> --scenario <exact-name> --editor-transition]", note: "configure prints an MCP TOML snippet; no credentials or upstream checkout are used" };
  if (!["configure", "start", "setup", "connect", "doctor", "list", "call", "run"].includes(command)) fail("unknown command");
  const opts = {};
  while (argv.length) {
    const key = argv.shift();
    if (key === "--editor-transition") {
      if (Object.hasOwn(opts, key)) fail("duplicate editor transition option");
      opts[key] = true; continue;
    }
    const value = argv.shift();
    if (!["--profile", "--expected-profile-sha256", "--tool", "--arguments-file", "--expected-arguments-sha256", "--feature", "--scenario"].includes(key) || !value || Object.hasOwn(opts, key)) fail("invalid or duplicate CLI option");
    opts[key] = value;
  }
  if (!opts["--profile"]) fail("--profile is required");
  if (command !== "call" && (opts["--tool"] || opts["--arguments-file"] || opts["--expected-arguments-sha256"])) fail("tool options require call");
  if (opts["--expected-arguments-sha256"] && !opts["--arguments-file"]) fail("arguments hash requires --arguments-file");
  if (command !== "run" && (opts["--feature"] || opts["--scenario"])) fail("feature/scenario options require run");
  if (command !== "run" && opts["--editor-transition"]) fail("editor transition requires run");
  const profile = loadProfile(opts["--profile"], opts["--expected-profile-sha256"]);
  if (command === "configure") return { status: "configuration_only", serverName: profile.mcp.serverName, snippet: configSnippet(profile), interactiveParameters: interactiveParameters(profile), readiness: "unverified" };
  if (command === "start") return start(profile);
  if (command === "doctor") return doctor(profile);
  return withProfileLock(profile, async () => {
    const manager = checkOwner(profile);
    let managerToken = null, callStarted = false, discovery = false, recordingAction, readyVersion, workflowProgress;
    const deadline = Date.now() + profile.limits.timeoutMs;
    try {
      return await session(profile, async client => {
        const tools = await listTools(client);
        if (command === "list") return { status: "available", tools };
        if (command === "connect") return connectSession(profile, client, tools);
        if (command === "setup") return setupSession(profile, client, tools);
        if (command === "run") return runFeature(profile, client, tools, { feature: opts["--feature"], scenario: opts["--scenario"],
          onProgress: progress => { workflowProgress = progress; },
          ...(opts["--editor-transition"] ? { beforeOpen: () => awaitEditorTransition({ managerPid: manager?.pid, timeoutMs: Math.min(60000, deadline - Date.now() - 1000) }) } : {}) });
        if (!opts["--tool"]) fail("--tool is required");
        const name = opts["--tool"], args = opts["--arguments-file"] ? readJson(opts["--arguments-file"], 1024 * 1024, opts["--expected-arguments-sha256"]) : {};
        if (name === "run_scenario" && !Object.hasOwn(args, "mode")) fail("run_scenario requires an explicit mode; all is never the CLI default");
        discovery = isDiscovery(name, args);
        if (!discovery) {
          if (manager?.pid && manager.created && managerAlive(profile, manager)) managerToken = digest(JSON.stringify([manager.pid, manager.created, manager.fingerprint]));
          let ownership = ownRecording(profile, managerToken);
          const readiness = await inspectSession(profile, client, tools, undefined, { ownRecording: Boolean(ownership) });
          if (readiness.status !== "ready") fail(`UI readiness is ${readiness.status}: ${readiness.reason}; dependent call blocked`);
          readyVersion = readiness.runtimeVersion;
          if (ownership && readiness.recording === false) { invalidateObservedIdle(profile, readyVersion); ownership = null; }
          if (ownership && ownership.runtimeVersion !== readyVersion) fail("recording runtime changed; ownership is unverified");
          if (name === "user_actions_recording") {
            recordingAction = args.action ?? "start";
            if (!managerToken) fail("recording ownership requires a verified manager process session launched by this profile");
            if (recordingAction === "start" && readiness.recording) fail("recording is already active; duplicate start blocked");
            if (recordingAction === "stop" && (!ownership || !readiness.recording)) fail("no verified recording owned by this profile to stop");
          }
        }
        const result = await callTool(client, tools, name, args, { onDispatch: () => {
          callStarted = true;
          if (recordingAction === "start") recordOwnership(profile, "starting", readyVersion, managerToken);
        } });
        if (recordingAction) recordOwnership(profile, recordingAction === "start" ? "active" : "idle", readyVersion, managerToken);
        return { status: "completed", tool: name, result };
      });
    } catch (error) {
      if (workflowProgress) {
        // The bounded HTTP session can reject before runFeature's own catch.
        // Keep dispatch evidence outside that race so a write timeout cannot
        // lose its tool/reports or be mistaken for an operation safe to repeat.
        const responded = error.code === "tool_error";
        const indeterminate = !responded && workflowProgress.pending && workflowProgress.mutation;
        const failure = responded ? error : new Error(indeterminate
          ? "UI mutation outcome is indeterminate; inspect authoritative state before retrying"
          : "UI run verification is unavailable; inspect state before another run");
        failure.code ??= indeterminate ? "mutation_indeterminate" : "verification_unavailable";
        const result = { ...workflowProgress, pending: responded ? false : workflowProgress.pending,
          status: "unverified", finishedAt: new Date().toISOString(),
          ...(responded ? { failure: { code: error.code, ...error.detail } } : {}) };
        failure.detail = { ...error.detail,
          ...(!responded ? { classification: "transport_or_protocol", outcome: indeterminate ? "indeterminate" : "unverified" } : {}),
          tool: workflowProgress.tool, reports: workflowProgress.reports, receipt: saveRunReceipt(profile, result),
          nextAction: responded ? "Inspect the runtime error and authoritative state before another run" : failure.message };
        throw failure;
      }
      if (error.code === "tool_error") throw error;
      if (callStarted && !discovery) {
        if (recordingAction) recordOwnership(profile, "indeterminate", readyVersion, managerToken);
        const uncertain = new Error("UI operation outcome is indeterminate; verify authoritative state before retrying (no automatic retry)");
        uncertain.code = "mutation_indeterminate";
        uncertain.detail = { classification: "transport_or_protocol", outcome: "indeterminate", tool: opts["--tool"], nextAction: uncertain.message };
        throw uncertain;
      }
      throw error;
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { create_diagnostic_logger } = await import("../scripts/diagnostics.mjs");
  const diagnostic = create_diagnostic_logger("vanessa");
  diagnostic.event("command_started", { action: process.argv[2] });
  try {
    const result = await main(process.argv.slice(2));
    diagnostic.event("command_completed", { action: process.argv[2], status: result?.status });
    process.stdout.write(JSON.stringify(redact(result), null, 2) + "\n");
    if (["error", "unverified"].includes(result?.status)) process.exitCode = 1;
  } catch (error) {
    diagnostic.event("command_failed", { action: process.argv[2], code: error.code, message: error.message }, "error");
    // Filesystem failures contain paths; raw process/server responses never become diagnostics.
    const message = error.detail ? error.message : error.code ? `local operation failed (${error.code})` : error.message;
    process.stderr.write(JSON.stringify(redact({ status: "error", message, ...(error.detail ?? {}) })) + "\n"); process.exitCode = 1;
  }
}
