// The private IPC channel is the owner's lifeline. Targets never inherit it.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { own_windows_tree, join_windows_reader_job } from "./windows_process.mjs";
import { linux_subreaper, linux_signal_children, linux_terminate_children, linux_finish_daemon_lease, linux_retain_daemon_barrier, linux_pidfd_exited, linux_pidfd_signal, linux_close_fd } from "./unix_process.mjs";
import { create_diagnostic_logger } from "./diagnostics.mjs";

let child, job, stopping = false, exitCode = 0, escalation, strictLinux = false, draining = false, forwarding = false, daemonGuard = false;
let ownerFd = null, guardFd = null, guardTimer = null, guardMisses = 0, daemonCommitted = false, guardId = null, guardDisconnected = false, guardKillRequested = false;
const finish = () => { clearTimeout(escalation); clearInterval(guardTimer); process.exit(exitCode); };
const signal_group = signal => {
  try { process.kill(-child.pid, signal); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(guardTimer);
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
function monitorDaemonGuard() {
  if (stopping) return;
  try {
    if ((!daemonCommitted && linux_pidfd_exited(ownerFd)) || linux_pidfd_exited(guardFd) || ++guardMisses > 5) {
      // The descriptor pins this exact guard, even if its PID has been reused.
      if (!linux_pidfd_exited(guardFd)) { guardKillRequested = true; linux_pidfd_signal(guardFd, 9); }
      return stop();
    }
    if (process.connected) process.send({ guardPing: true }, () => {});
  } catch (error) {
    try { linux_retain_daemon_barrier(process.cwd(), "daemon_guard_monitor_unknown"); } catch {}
    if (process.env.EDT_AI_STATE_DIR) create_diagnostic_logger("index-daemon", process.env.EDT_AI_STATE_DIR)
      .event("daemon_guard_monitor_failed", { supervisorPid: process.pid, error }, "error");
    stop();
  }
}
async function drainLinux() {
  if (draining) return; draining = true; clearTimeout(escalation);
  const deadline = performance.now() + (daemonGuard ? 5000 : 2500);
  try {
    do {
      if (linux_terminate_children(child?.pid)) {
        if (daemonGuard && (guardDisconnected || guardKillRequested || linux_pidfd_exited(guardFd))) {
          while (!linux_pidfd_exited(guardFd) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
          if (!linux_pidfd_exited(guardFd)) throw new Error("Daemon outer guard termination is not confirmed");
          linux_finish_daemon_lease(process.cwd(), guardId);
        }
        if (process.connected) return process.send({ readerTree: "terminated" }, () => finish());
        return finish();
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
  } catch { /* The owner must retain the unconfirmed reader barrier. */ }
  if (daemonGuard) {
    const diagnostic = process.env.EDT_AI_STATE_DIR ? create_diagnostic_logger("index-daemon", process.env.EDT_AI_STATE_DIR) : null;
    try { linux_retain_daemon_barrier(process.cwd(), "daemon_guard_cleanup_unknown"); diagnostic?.event("daemon_guard_cleanup_unconfirmed", { supervisorPid: process.pid }, "error"); }
    catch (error) { diagnostic?.event("daemon_guard_barrier_failed", { supervisorPid: process.pid, error }, "error"); }
  }
  exitCode = 1; finish();
}
process.once("disconnect", () => { guardDisconnected = true; stop(); });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", ({ command, args, env, readerJob, forwardIpc, relay, daemonGuard: guard, daemonGuardId, guardPrepare, guardCommit, guardPong, stop: requested }) => {
  if (requested) return stop();
  if (guardPong && daemonGuard) { guardMisses = 0; return; }
  if (guardPrepare && daemonGuard && !stopping) { if (process.connected) process.send({ guardPrepared: true }); return; }
  if (guardCommit && daemonGuard && !stopping) {
    try {
      if (linux_pidfd_exited(ownerFd) || linux_pidfd_exited(guardFd)) return stop();
      linux_close_fd(ownerFd); ownerFd = null; daemonCommitted = true;
      if (process.connected) process.send({ guardCommitted: true });
    } catch (error) {
      try { linux_retain_daemon_barrier(process.cwd(), "daemon_guard_handoff_unknown"); } catch {}
      stop();
    }
    return;
  }
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
    daemonGuard = guard === true && strictLinux;
    if (daemonGuard) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(daemonGuardId || "")) throw new Error("Invalid daemon guard identity");
      guardId = daemonGuardId;
      ownerFd = 3; guardFd = 4;
      if (linux_pidfd_exited(ownerFd) || linux_pidfd_exited(guardFd)) throw new Error("Daemon startup owner has exited");
      guardTimer = setInterval(monitorDaemonGuard, 1000);
    }
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
