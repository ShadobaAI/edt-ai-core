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
  if (!command || command === "help" || command === "--help") return { usage: "node vanessa.mjs <configure|start|setup|connect|doctor|list|call|run> --profile <file> [--client <name>] [--tool <actual-name> --arguments-file <json>] [--feature <file> --scenario <exact-name> --editor-transition]", note: "configure prints an MCP TOML snippet; no credentials or upstream checkout are used" };
  if (!["configure", "start", "setup", "connect", "doctor", "list", "call", "run"].includes(command)) fail("Неизвестная команда");
  const opts = {};
  while (argv.length) {
    const key = argv.shift();
    if (key === "--editor-transition") {
      if (Object.hasOwn(opts, key)) fail("Повторный параметр перехода в редактор");
      opts[key] = true; continue;
    }
    const value = argv.shift();
    if (!["--profile", "--client", "--expected-profile-sha256", "--tool", "--arguments-file", "--expected-arguments-sha256", "--feature", "--scenario"].includes(key) || !value || Object.hasOwn(opts, key)) fail("Некорректный или повторный параметр командной строки");
    opts[key] = value;
  }
  if (!opts["--profile"]) fail("Требуется --profile");
  if (command !== "call" && (opts["--tool"] || opts["--arguments-file"] || opts["--expected-arguments-sha256"])) fail("Параметры инструмента требуют команды call");
  if (opts["--expected-arguments-sha256"] && !opts["--arguments-file"]) fail("Для хеша аргументов требуется --arguments-file");
  if (command !== "run" && (opts["--feature"] || opts["--scenario"])) fail("Параметры feature/scenario требуют команды run");
  if (command !== "run" && opts["--editor-transition"]) fail("Переход в редактор требует команды run");
  const profile = loadProfile(opts["--profile"], opts["--expected-profile-sha256"], opts["--client"]);
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
        if (!opts["--tool"]) fail("Требуется --tool");
        const name = opts["--tool"], args = opts["--arguments-file"] ? readJson(opts["--arguments-file"], 1024 * 1024, opts["--expected-arguments-sha256"]) : {};
        if (name === "run_scenario" && !Object.hasOwn(args, "mode")) fail("Для run_scenario нужен явный mode; all не используется в командной строке по умолчанию");
        discovery = isDiscovery(name, args);
        if (!discovery) {
          if (manager?.pid && manager.created && managerAlive(profile, manager)) managerToken = digest(JSON.stringify([manager.pid, manager.created, manager.fingerprint]));
          let ownership = ownRecording(profile, managerToken);
          const readiness = await inspectSession(profile, client, tools, undefined, { ownRecording: Boolean(ownership) });
          if (readiness.status !== "ready") fail(`Готовность интерфейса: ${readiness.status}: ${readiness.reason}; зависимый вызов заблокирован`);
          readyVersion = readiness.runtimeVersion;
          if (ownership && readiness.recording === false) { invalidateObservedIdle(profile, readyVersion); ownership = null; }
          if (ownership && ownership.runtimeVersion !== readyVersion) fail("Среда записи изменилась; владение не подтверждено");
          if (name === "user_actions_recording") {
            recordingAction = args.action ?? "start";
            if (!managerToken) fail("Для владения записью нужна подтверждённая сессия процесса менеджера, запущенного этим профилем");
            if (recordingAction === "start" && readiness.recording) fail("Запись уже активна; повторный запуск заблокирован");
            if (recordingAction === "stop" && (!ownership || !readiness.recording)) fail("Нет подтверждённой записи этого профиля для остановки");
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
          ? "Исход изменения интерфейса неизвестен; перед повтором проверьте фактическое состояние"
          : "Проверка выполнения через интерфейс недоступна; перед новым запуском проверьте состояние");
        failure.code ??= indeterminate ? "mutation_indeterminate" : "verification_unavailable";
        const result = { ...workflowProgress, pending: responded ? false : workflowProgress.pending,
          status: "unverified", finishedAt: new Date().toISOString(),
          ...(responded ? { failure: { code: error.code, ...error.detail } } : {}) };
        failure.detail = { ...error.detail,
          ...(!responded ? { classification: "transport_or_protocol", outcome: indeterminate ? "indeterminate" : "unverified" } : {}),
          tool: workflowProgress.tool, reports: workflowProgress.reports, receipt: saveRunReceipt(profile, result),
          nextAction: responded ? "Перед новым запуском проверьте ошибку среды выполнения и фактическое состояние" : failure.message };
        throw failure;
      }
      if (error.code === "tool_error") throw error;
      if (callStarted && !discovery) {
        if (recordingAction) recordOwnership(profile, "indeterminate", readyVersion, managerToken);
        const uncertain = new Error("Исход операции интерфейса неизвестен; перед повтором проверьте фактическое состояние; автоматического повтора нет");
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
    const message = error.detail ? error.message : error.code ? `Локальная операция не удалась (${error.code})` : error.message;
    process.stderr.write(JSON.stringify(redact({ status: "error", message, ...(error.detail ?? {}) })) + "\n"); process.exitCode = 1;
  }
}
