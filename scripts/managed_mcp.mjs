import { argumentsOf, settings, state_path, entrypoint } from "./common.mjs";
import { launch_command, project, acquire_reader } from "./runtime.mjs";
import { require_preparation } from "./components.mjs";
import { effective_settings } from "./project_context.mjs";
import { launch, stop_child, require_protected_process_support } from "./processes.mjs";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { create_diagnostic_logger, register_diagnostic_secrets } from "./diagnostics.mjs";
export async function serve(component, selected, state, config) {
  const [root, data] = project(selected, config, component === "code-index");
  config = effective_settings(config, root, data, null, state);
  register_diagnostic_secrets(config);
  const diagnostic = create_diagnostic_logger("managed-" + component, state);
  require_preparation(state, root, component);
  require_protected_process_support();
  const lease = component === "code-index" ? await acquire_reader(state, root, { preparing: true }) : null;
  let launching = false, stopped = false;
  try {
    await lease?.assertAvailable();
    const [command, cwd, env] = await launch_command(state, config, component, root, data, false, null, true, lease?.id);
    await lease?.assertAvailable();
    await lease?.arm();
    launching = Boolean(lease);
    let child;
    try { child = launch(command[0], command.slice(1), {
      cwd,
      env: env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
      readerJob: lease?.id || randomUUID(),
    }); } catch (error) { if (error.notSpawned) launching = false; throw error; }
    diagnostic.event("process_started", { projectRoot: root, supervisorPid: child.pid, executable: command[0] });
    let stderrBytes = 0, stderrChunks = 0;
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; stderrChunks++; });
    let stopping;
    const reportShutdown = error => diagnostic.event("process_shutdown_failed", { projectRoot: root, error }, "error");
    const inputEnded = () => {
      if (!stopping) { stopping = stop_child(child); void stopping.catch(reportShutdown); }
    };
    const terminate = () => { void stop_child(child, 0).catch(reportShutdown); };
    process.once("SIGTERM", terminate);
    process.once("SIGINT", terminate);
    child.stdin.on("error", () => {});
    process.stdin.pipe(child.stdin);
    process.stdin.once("end", inputEnded);
    process.stdin.once("close", inputEnded);
    process.stdin.once("error", inputEnded);
    child.stdout.pipe(process.stdout, { end: false });
    try {
      const [code] = await once(child, "close");
      if (stderrChunks) diagnostic.event("runtime_stderr", { projectRoot: root, bytes: stderrBytes, count: stderrChunks });
      diagnostic.event("process_exited", { projectRoot: root, exitCode: code }, code === 0 ? "info" : "error");
      return code ?? 1;
    } finally {
      process.stdin.unpipe(child.stdin);
      process.stdin.pause();
      process.stdin.removeListener("end", inputEnded);
      process.stdin.removeListener("close", inputEnded);
      process.stdin.removeListener("error", inputEnded);
      try { await (stopping || stop_child(child)); stopped = true; }
      finally { process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", terminate); }
    }
  } finally {
    if (lease && (!launching || stopped)) await lease.close();
    else if (lease) await lease.abandon();
  }
}
export async function main() {
  const a = argumentsOf(
    undefined,
    ["direct"],
    ["component", "project_root", "state_dir", "settings", "node"],
  );
  if (!["code-index", "bsl-ls"].includes(a.component))
    throw new Error("Select --component code-index or bsl-ls");
  const config = settings(a.settings);
  return serve(
    a.component,
    a.project_root,
    state_path(config, a.state_dir),
    config,
  );
}
if (entrypoint(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    create_diagnostic_logger("managed").event("launch_failed", { error }, "error");
    process.stderr.write("1c-ai-core: " + error.message + "\n");
    process.exitCode = 1;
  }
}
