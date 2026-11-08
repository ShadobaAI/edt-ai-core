// Two existing Linux subreapers protect a project daemon. This outer guard
// adopts the inner supervisor's descendants if that supervisor dies; if this
// process dies, the inner supervisor's private IPC closes and it drains them.
import { randomUUID } from "node:crypto";
import { launch } from "./processes.mjs";
import { linux_parent_pid, pin_linux_process, linux_finish_daemon_lease, linux_retain_daemon_barrier, linux_subreaper, linux_terminate_children } from "./unix_process.mjs";
import { create_diagnostic_logger } from "./diagnostics.mjs";

const diagnostic = process.env.EDT_AI_STATE_DIR ? create_diagnostic_logger("index-daemon", process.env.EDT_AI_STATE_DIR) : null;
const guardId = process.env.EDT_AI_DAEMON_GUARD_ID; delete process.env.EDT_AI_DAEMON_GUARD_ID;
let worker, workerSpawnAttempted = false, targetPid, stopping = false, committing = false, committed = false, draining = false, failure = null, workerTimer = null, workerMisses = 0;
const send = message => { if (process.connected) try { process.send(message, () => {}); } catch {} };
const finish = (code, message) => {
  clearInterval(workerTimer);
  if (message && process.connected) {
    try { return process.send(message, () => process.exit(code)); } catch {}
  }
  process.exit(code);
};
async function drain(reason) {
  if (draining) return;
  draining = true; stopping = true;
  diagnostic?.event("daemon_guard_stopping", { supervisorPid: process.pid, workerPid: worker?.pid, targetPid, reason });
  if (worker?.connected) try { worker.send({ stop: true }, () => {}); } catch {}
  const forceAt = performance.now() + 2200, deadline = performance.now() + 6000;
  try {
    if (!worker && !workerSpawnAttempted) {
      linux_finish_daemon_lease(process.cwd(), guardId);
      return finish(0, { cleanup: "terminated" });
    }
    do {
      // Give the inner subreaper a chance to drain. If it died or did not
      // finish promptly, kill only this subreaper's pinned direct children;
      // adopted descendants are discovered in subsequent passes.
      if (!worker || worker.exitCode !== null || worker.signalCode !== null || performance.now() >= forceAt)
        if (linux_terminate_children(worker?.pid) && (!worker || worker.exitCode !== null || worker.signalCode !== null)) {
          linux_finish_daemon_lease(process.cwd(), guardId);
          diagnostic?.event("daemon_guard_stopped", { supervisorPid: process.pid, workerPid: worker?.pid, targetPid, reason });
          return finish(0, { cleanup: "terminated" });
        }
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    throw new Error("Owned daemon tree termination is not confirmed");
  } catch (error) {
    try { linux_retain_daemon_barrier(process.cwd(), "daemon_guard_cleanup_unknown"); }
    catch (barrier) { diagnostic?.event("daemon_guard_barrier_failed", { supervisorPid: process.pid, error: barrier }, "error"); }
    diagnostic?.event("daemon_guard_cleanup_failed", { supervisorPid: process.pid, workerPid: worker?.pid, targetPid, error }, "error");
    return finish(1, { cleanup: "unknown" });
  }
}
process.once("disconnect", () => { if (!committed) void drain("owner_lost"); });
process.on("SIGTERM", () => { void drain("signal"); });
process.on("SIGINT", () => { void drain("signal"); });
process.on("message", message => {
  if (message?.stop) { if (!committed) void drain("rollback"); return; }
  if (message?.commit) {
    if (!stopping && !committing && worker && targetPid && worker.exitCode === null && worker.signalCode === null) {
      committing = true;
      worker.send({ guardPrepare: true }, error => { if (error) void drain("handoff_error"); });
    }
    return;
  }
  if (!message?.start || worker || stopping || !process.connected) return;
  const { command, args, env, ownerPid } = message.start;
  try {
    if (typeof command !== "string" || !Array.isArray(args) || !env || typeof env !== "object" || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error("Invalid daemon startup request");
    // Establish containment before the inner supervisor or its target exists.
    linux_subreaper();
    const owner = pin_linux_process(ownerPid); let guard;
    try {
      guard = pin_linux_process(process.pid);
      if (linux_parent_pid() !== ownerPid || !owner.alive()) throw new Error("Daemon startup owner has exited");
      // Only the inner guard receives these pidfds. The native target gets
      // stdio 0..2 only, and cannot keep either owner handle alive.
      workerSpawnAttempted = true;
      worker = launch(command, args, { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "ignore", owner.descriptor, guard.descriptor], readerJob: randomUUID(), daemonGuard: true, daemonGuardId: guardId });
    } finally { try { guard?.close(); } finally { owner.close(); } }
    diagnostic?.event("daemon_guard_started", { supervisorPid: process.pid, workerPid: worker.pid });
    worker.on("message", item => {
      if (item.guardPing && worker.connected) { workerMisses = 0; try { worker.send({ guardPong: true }, () => {}); } catch { void drain("worker_channel_error"); } return; }
      if (item.guardPrepared && committing && !stopping && process.connected) {
        worker.send({ guardCommit: true }, error => { if (error) void drain("handoff_error"); });
        return;
      }
      if (item.guardCommitted && committing && !stopping && process.connected) {
        committed = true;
        diagnostic?.event("daemon_guard_committed", { supervisorPid: process.pid, workerPid: worker.pid, targetPid });
        send({ committed: true }); return;
      }
      if (!targetPid && Number.isSafeInteger(item.readerGroup) && item.readerGroup > 0) {
        targetPid = item.readerGroup;
        send({ started: { pid: targetPid, guardPid: process.pid, workerPid: worker.pid } });
      }
    });
    worker.on("error", error => { failure = error; send({ error: { message: error.message, code: error.code } }); void drain("worker_error"); });
    worker.once("close", (code, signal) => {
      if (!stopping) {
        if (!committed) send({ error: { message: failure?.message || "Daemon supervisor exited during startup", code: failure?.code } });
        void drain(signal ? "worker_signal" : "worker_exit");
      }
    });
    workerTimer = setInterval(() => { if (!stopping && ++workerMisses > 7) void drain("worker_unresponsive"); }, 1000);
  } catch (error) {
    send({ error: { message: error.message, code: error.code } });
    void drain("startup_error");
  }
});
