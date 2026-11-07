import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { create_windows_reader_job } from "./windows_process.mjs";
const lifecycles = new WeakMap();
export function require_protected_process_support() {
  // A process group on macOS cannot prove that a child did not call setsid().
  // Refuse to launch until the complete owned tree can be contained and tested.
  if (process.platform === "darwin") throw Object.assign(new Error("Безопасное управление деревом локального компонента на macOS пока недоступно."), { code: "PROCESS_CONTAINMENT_UNAVAILABLE", notSpawned: true });
}
export function launch(command, args = [], options = {}) {
  const { sessionOwned = true, readerJob = null, forwardIpc = false, ...spawnOptions } = options;
  if (readerJob && !sessionOwned) throw new Error("A reader job requires session ownership");
  if (forwardIpc && !sessionOwned) throw new Error("Forwarded IPC requires session ownership");
  let job = null;
  const detached = spawnOptions.detached ?? process.platform !== "win32";
  const env = spawnOptions.env || process.env;
  const stdio = spawnOptions.stdio ?? "pipe";
  let child;
  try {
    if (readerJob) require_protected_process_support();
    job = readerJob && process.platform === "win32" ? create_windows_reader_job(readerJob) : null;
    child = spawn(sessionOwned ? process.execPath : command, sessionOwned ? [fileURLToPath(new URL("./process_supervisor.mjs", import.meta.url))] : args, {
    windowsHide: true,
    ...spawnOptions,
    ...(sessionOwned ? {
      env: Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== "NODE_OPTIONS")),
      stdio: [...(Array.isArray(stdio) ? stdio : [stdio, stdio, stdio]), "ipc"],
    } : {}),
    detached,
    shell: false,
    });
  } catch (error) { job?.close(); error.notSpawned = true; throw error; }
  const lifecycle = { supervised: sessionOwned, closed: false, stopping: null, readerJob, job, readerGroup: null, readerTree: null };
  lifecycles.set(child, lifecycle);
  child.once("close", () => { lifecycle.closed = true; });
  if (sessionOwned) {
    child.on("message", message => { if (message.readerGroup && Number.isSafeInteger(message.readerGroup)) lifecycle.readerGroup = message.readerGroup;
      if (["terminated", "not_started"].includes(message.readerTree)) lifecycle.readerTree = message.readerTree;
      if (message.error) child.emit("error", Object.assign(new Error(message.error.message), message.error)); });
    if (child.pid) try {
      child.send({ command, args, env, ...(readerJob ? { readerJob } : {}), ...(forwardIpc ? { forwardIpc: true } : {}) }, error => {
        if (error && child.exitCode === null && child.signalCode === null) child.emit("error", error);
      });
    } catch (error) {
      void stop_child(child, 0).catch(() => {});
      error.outcomeUnknown = true; throw error;
    }
  }
  return child;
}
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
export function stop_child(child, grace = 5000) {
  let lifecycle = lifecycles.get(child);
  if (!lifecycle) {
    lifecycle = { supervised: false, closed: child.exitCode !== null || child.signalCode !== null, stopping: null };
    lifecycles.set(child, lifecycle);
  }
  return lifecycle.stopping ||= terminate_child(child, lifecycle, grace).catch(error => {
    // Do not retain a controller handle forever when completion is unknown.
    // The durable reader marker remains; closing the last job handle also
    // requests termination of its members on Windows.
    lifecycle.job?.close(); lifecycle.job = null;
    throw error;
  });
}
async function terminate_child(child, lifecycle, grace) {
  if (lifecycle.closed) return confirm_reader_tree(lifecycle);
  const closed = new Promise(resolve => child.once("close", resolve));
  child.stdin?.end();
  let timer;
  const gone = await Promise.race([
    closed.then(() => true),
    new Promise((done) => {
      timer = setTimeout(() => done(false), grace);
    }),
  ]);
  clearTimeout(timer);
  if (gone) return confirm_reader_tree(lifecycle);
  // This handle was created by this session. Never kill by name or state-file PID.
  if (lifecycle.supervised) {
    if (child.connected) child.send({ stop: true }, () => {});
  } else child.kill("SIGKILL");
  // A retained job handle deliberately prevents kill-on-last-close. Explicitly
  // terminate its members before waiting for their inherited stdio to close.
  if (lifecycle.job) lifecycle.job.terminate();
  if (!lifecycle.closed) {
    let finalTimer;
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        finalTimer = setTimeout(
          () => reject(Object.assign(new Error("Owned process termination is not confirmed"), { outcomeUnknown: true })),
          5000,
        );
      }),
    ]).finally(() => clearTimeout(finalTimer));
  }
  await confirm_reader_tree(lifecycle);
}

async function confirm_reader_tree(lifecycle) {
  if (!lifecycle.readerJob) return;
  const uncertain = () => Object.assign(new Error("Owned index reader tree termination is not confirmed"), { outcomeUnknown: true });
  if (lifecycle.job) {
    const job = lifecycle.job, deadline = performance.now() + 5000;
    try {
      if (job.active()) job.terminate();
      while (job.active() && performance.now() < deadline) await new Promise(done => setTimeout(done, 50));
      if (job.active()) throw uncertain();
    } finally { job.close(); lifecycle.job = null; }
    return;
  }
  if (lifecycle.readerTree === "not_started") return;
  // A missing group notification is not proof that the native child did not
  // start. Never signal a saved PID after the supervisor has disappeared.
  if (process.platform === "linux") {
    if (lifecycle.readerTree !== "terminated") throw uncertain();
    return;
  }
  const group = lifecycle.readerGroup;
  if (!group) throw uncertain();
  const deadline = performance.now() + 5000;
  while (true) {
    try { process.kill(-group, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw uncertain(); }
    if (performance.now() >= deadline) throw uncertain();
    await new Promise(done => setTimeout(done, 50));
  }
}
export function which(program) {
  const candidates =
    path.isAbsolute(program) || /[\\/]/.test(program)
      ? [program]
      : (process.env.PATH || "")
          .split(path.delimiter)
          .map((dir) => path.join(dir, program));
  for (const candidate of candidates)
    for (const suffix of process.platform === "win32" &&
    !path.extname(candidate)
      ? [".exe", ""]
      : [""]) {
      try {
        fs.accessSync(
          candidate + suffix,
          process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
        );
        if (fs.statSync(candidate + suffix).isFile()) return candidate + suffix;
      } catch {}
    }
  return null;
}
export function run_sync(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
    shell: false,
  });
  if (result.error || result.status !== 0)
    throw (
      result.error ||
      new Error(result.stderr || `${command} exited (${result.status})`)
    );
  return result.stdout.trim();
}
