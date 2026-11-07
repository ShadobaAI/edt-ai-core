// The private IPC channel is the owner's lifeline. Targets never inherit it.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { own_windows_tree, join_windows_reader_job } from "./windows_process.mjs";
import { linux_subreaper, linux_signal_children, linux_terminate_children } from "./unix_process.mjs";

let child, job, stopping = false, exitCode = 0, escalation, strictLinux = false, draining = false, forwarding = false;
const finish = () => { clearTimeout(escalation); process.exit(exitCode); };
const signal_group = signal => {
  try { process.kill(-child.pid, signal); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
function stop() {
  if (stopping) return;
  stopping = true;
  // Exiting closes the Windows Job handle, including all inherited descendants.
  if (process.platform === "win32") return finish();
  if (strictLinux) {
    // Only pidfds for this supervisor's live children may be signalled; the
    // former process-group leader's numeric PID may already have been reused.
    try { linux_signal_children(15); } catch { /* Escalation will fail closed if ownership remains unknown. */ }
    // The subreaper also owns children that changed session or process group.
    escalation = setTimeout(drainLinux, 2000);
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) void drainLinux();
    return;
  }
  if (!child?.pid) return finish();
  if (!signal_group("SIGTERM")) return finish();
  escalation = setTimeout(() => {
    signal_group("SIGKILL");
    // Sending SIGKILL does not reap the target or record its exit status.
    if (child.exitCode !== null || child.signalCode !== null) finish();
    else child.once("exit", finish);
  }, 2000);
}
async function drainLinux() {
  if (draining) return; draining = true; clearTimeout(escalation);
  const deadline = performance.now() + 2500;
  try {
    do {
      if (linux_terminate_children(child?.pid)) {
        if (process.connected) return process.send({ readerTree: "terminated" }, () => finish());
        return finish();
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
  } catch { /* The owner must retain the unconfirmed reader barrier. */ }
  exitCode = 1; finish();
}
process.once("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", ({ command, args, env, readerJob, forwardIpc, relay, stop: requested }) => {
  if (requested) return stop();
  if (relay !== undefined) {
    if (forwarding && child?.connected) child.send(relay, () => {});
    return;
  }
  if (child) return;
  if (!process.connected || stopping) return stop();
  try {
    // Establish the Job before the target exists. Kernel inheritance protects
    // even descendants spawned by the target's very first instruction.
    if (process.platform === "win32") job = readerJob ? join_windows_reader_job(readerJob, process.pid) : own_windows_tree(process.pid);
    if (process.platform === "linux" && readerJob) { linux_subreaper(); strictLinux = true; }
    forwarding = forwardIpc === true;
    child = spawn(command, args, {
      env, windowsHide: true, shell: false,
      detached: process.platform !== "win32", stdio: [0, 1, 2, ...(forwarding ? ["ipc"] : [])],
    });
    if (forwarding) child.on("message", message => {
      if (process.connected) process.send({ relay: message }, () => {});
    });
    if (readerJob && process.platform !== "win32" && child.pid && process.connected)
      process.send({ readerGroup: child.pid });
    child.once("error", error => {
      exitCode = 1;
      if (process.connected) process.send({ error: { message: error.message, code: error.code, path: error.path, syscall: error.syscall },
        ...(readerJob && !child.pid ? { readerTree: "not_started" } : {}) }, stop);
      else stop();
    });
    child.once("exit", (code, signal) => {
      exitCode = code ?? 128 + (constants.signals[signal] || 1);
      if (!stopping) stop();
      else if (strictLinux) void drainLinux();
      else if (process.platform !== "win32" && !signal_group(0)) finish();
    });
  } catch (error) {
    exitCode = 1;
    if (process.connected) process.send({ error: { message: error.message, code: error.code },
      ...(readerJob && !child?.pid ? { readerTree: "not_started" } : {}) }, stop);
    else stop();
  }
});
