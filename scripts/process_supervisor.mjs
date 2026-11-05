// The private IPC channel is the owner's lifeline. Targets never inherit it.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { own_windows_tree } from "./windows_process.mjs";

let child, job, stopping = false, exitCode = 0, escalation;
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
  if (!child?.pid) return finish();
  if (!signal_group("SIGTERM")) return finish();
  escalation = setTimeout(() => {
    signal_group("SIGKILL");
    // Sending SIGKILL does not reap the target or record its exit status.
    if (child.exitCode !== null || child.signalCode !== null) finish();
    else child.once("exit", finish);
  }, 2000);
}
process.once("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", ({ command, args, env, stop: requested }) => {
  if (requested) return stop();
  if (child) return;
  if (!process.connected || stopping) return stop();
  try {
    // Establish the Job before the target exists. Kernel inheritance protects
    // even descendants spawned by the target's very first instruction.
    if (process.platform === "win32") job = own_windows_tree(process.pid);
    child = spawn(command, args, {
      env, windowsHide: true, shell: false,
      detached: process.platform !== "win32", stdio: [0, 1, 2],
    });
    child.once("error", error => {
      exitCode = 1;
      if (process.connected) process.send({ error: { message: error.message, code: error.code, path: error.path, syscall: error.syscall } }, stop);
      else stop();
    });
    child.once("exit", (code, signal) => {
      exitCode = code ?? 128 + (constants.signals[signal] || 1);
      if (!stopping) stop();
      else if (process.platform !== "win32" && !signal_group(0)) finish();
    });
  } catch (error) {
    exitCode = 1;
    if (process.connected) process.send({ error: { message: error.message, code: error.code } }, stop);
    else stop();
  }
});
