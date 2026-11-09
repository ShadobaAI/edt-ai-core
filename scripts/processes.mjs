import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { create_windows_reader_job } from "./windows_process.mjs";
import { linux_create_daemon_lease, linux_finish_daemon_lease, linux_process_identity, linux_read_daemon_lease, pin_linux_process } from "./unix_process.mjs";
const lifecycles = new WeakMap();
export function require_protected_process_support() {
  // A process group on macOS cannot prove that a child did not call setsid().
  // Refuse to launch until the complete owned tree can be contained and tested.
  if (process.platform === "darwin") throw Object.assign(new Error("Безопасное управление деревом локального компонента на macOS пока недоступно."), { code: "PROCESS_CONTAINMENT_UNAVAILABLE", notSpawned: true });
}
export function launch(command, args = [], options = {}) {
  const { sessionOwned = true, readerJob = null, readerCompletion = null, forwardIpc = false, daemonGuard = false, daemonGuardId = null, ...spawnOptions } = options;
  if (readerJob && !sessionOwned) throw new Error("A reader job requires session ownership");
  if (readerCompletion && (!readerJob || process.platform !== "linux" || !path.isAbsolute(readerCompletion))) throw new Error("Invalid reader completion receipt");
  if (forwardIpc && !sessionOwned) throw new Error("Forwarded IPC requires session ownership");
  if (daemonGuard && (process.platform !== "linux" || !readerJob || !sessionOwned)) throw new Error("A daemon guard requires a protected Linux supervisor");
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
      child.send({ command, args, env, ...(readerJob ? { readerJob } : {}), ...(readerCompletion ? { readerCompletion } : {}), ...(forwardIpc ? { forwardIpc: true } : {}), ...(daemonGuard ? { daemonGuard: true, daemonGuardId } : {}) }, error => {
        if (error && child.exitCode === null && child.signalCode === null) child.emit("error", error);
      });
    } catch (error) {
      void stop_child(child, 0).catch(() => {});
      error.outcomeUnknown = true; throw error;
    }
  }
  return child;
}

// The project daemon has a longer lifetime than its launcher. Two Linux
// subreapers supervise each other and keep the native tree contained through
// both startup and its deliberately persistent project lifetime.
export async function spawn_guarded_linux(command, args, options) {
  if (process.platform !== "linux" || !path.isAbsolute(command) || !path.isAbsolute(options.cwd || ""))
    throw Object.assign(new Error("Guarded daemon startup requires an absolute Linux executable and directory"), { notSpawned: true });
  const guardId = randomUUID(), lifecycle = path.join(options.cwd, "guard-lifecycle.json"), previous = linux_read_daemon_lease(options.cwd);
  if (previous?.state === "active") throw Object.assign(new Error("Предыдущая очистка дерева демона не подтверждена: " + lifecycle), { code: "DAEMON_GUARD_ACTIVE", notSpawned: true });
  if (previous?.state === "completed") {
    // A finishing supervisor writes the receipt immediately before it exits.
    // Do not reuse its path while that exact process can still write to it.
    const finisher = previous.finisher, identity = finisher && linux_process_identity(finisher.pid);
    if (finisher && !identity && alive(finisher.pid)) throw Object.assign(new Error("Не удалось подтвердить завершение наблюдателя демона."), { outcomeUnknown: true });
    if (finisher && identity === finisher.creation) {
      const pin = pin_linux_process(finisher.pid);
      try {
        const deadline = performance.now() + 6000;
        while (pin.alive() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (pin.alive()) throw Object.assign(new Error("Не подтверждено завершение наблюдателя демона."), { outcomeUnknown: true });
      } finally { pin.close(); }
    }
    const current = linux_read_daemon_lease(options.cwd);
    if (!current || current.id !== previous.id || current.state !== "completed") throw Object.assign(new Error("Запись наблюдателя демона изменилась."), { outcomeUnknown: true });
    fs.unlinkSync(lifecycle);
  }
  linux_create_daemon_lease(options.cwd, guardId);
  const env = Object.fromEntries(Object.entries(options.env || process.env).filter(([name]) => !["NODE_OPTIONS", "EDT_AI_DAEMON_GUARD_ID"].includes(name.toUpperCase())));
  env.EDT_AI_DAEMON_GUARD_ID = guardId;
  let guard;
  try {
    guard = spawn(process.execPath, [fileURLToPath(new URL("./linux_daemon_guard.mjs", import.meta.url))], {
      cwd: options.cwd, env, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], shell: false,
    });
  } catch (error) { linux_finish_daemon_lease(options.cwd, guardId, { notSpawned: true }); error.notSpawned = true; throw error; }
  const events = new EventEmitter(); events.on("error", () => {});
  let startResolve, startReject, commitResolve, commitReject, cleanupResolve, cleanupReject;
  const started = new Promise((resolve, reject) => { startResolve = resolve; startReject = reject; });
  const handoff = new Promise((resolve, reject) => { commitResolve = resolve; commitReject = reject; });
  const cleanup = new Promise((resolve, reject) => { cleanupResolve = resolve; cleanupReject = reject; });
  for (const pending of [started, handoff, cleanup]) pending.catch(() => {});
  let info, failure, committed = false, cleaned = false, rollbackPromise, exitCode = null, signalCode = null;
  const closed = new Promise(resolve => guard.once("close", resolve));
  const uncertain = message => Object.assign(new Error(message), { outcomeUnknown: true });
  guard.on("message", message => {
    if (message?.started && !info) { info = message.started; startResolve(info); }
    if (message?.error) {
      failure = Object.assign(new Error(message.error.message || "Daemon startup failed"), { code: message.error.code });
      startReject(failure); events.emit("error", failure);
    }
    if (message?.committed === true) { committed = true; commitResolve(); }
    if (message?.cleanup === "terminated") { cleaned = true; cleanupResolve(); }
    if (message?.cleanup === "unknown") cleanupReject(uncertain("Daemon startup cleanup is not confirmed"));
  });
  guard.on("error", error => { failure = error; startReject(error); commitReject(error); cleanupReject(error); events.emit("error", error); });
  guard.once("exit", (code, signal) => { exitCode = code; signalCode = signal; });
  guard.once("close", () => {
    const error = failure || uncertain("Daemon startup supervisor exited without confirmation");
    startReject(error); if (!committed) commitReject(error); if (!cleaned) cleanupReject(error);
    if (info && !committed) events.emit("error", error);
  });
  const bounded = async (promise, message) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(uncertain(message)), 9000); })]); }
    finally { clearTimeout(timer); }
  };
  const rollback = () => rollbackPromise ||= (async () => {
    if (committed) throw uncertain("A committed daemon cannot be rolled back as an unfinished startup");
    if (!guard.connected && !cleaned) throw uncertain("Daemon startup cleanup is not confirmed");
    if (guard.connected) try { guard.send({ stop: true }, () => {}); } catch {}
    await bounded(Promise.all([cleanup, closed]), "Daemon startup cleanup is not confirmed");
  })();
  try {
    if (!guard.pid) { linux_finish_daemon_lease(options.cwd, guardId, { notSpawned: true }); throw Object.assign(new Error("Daemon startup supervisor did not start"), { notSpawned: true }); }
    guard.send({ start: { command, args, env: options.env || process.env, ownerPid: process.pid } }, error => { if (error) startReject(error); });
    await bounded(started, "Daemon startup supervisor did not confirm its child");
  } catch (error) {
    if (!error.notSpawned) try { await rollback(); } catch (cleanupError) { error.outcomeUnknown = true; error.cause = cleanupError; }
    if (guard.connected) try { guard.disconnect(); } catch {}
    guard.unref();
    throw error;
  }
  return {
    pid: info.pid, guardPid: info.guardPid, workerPid: info.workerPid, guardId,
    get exitCode() { return exitCode; }, get signalCode() { return signalCode; },
    once(name, listener) { events.once(name, listener); return this; }, unref() {},
    async commit() {
      if (committed) return;
      if (rollbackPromise || !guard.connected) throw uncertain("Daemon ownership handoff is not confirmed");
      try { guard.send({ commit: true }, error => { if (error) commitReject(error); }); }
      catch (error) { throw Object.assign(error, { outcomeUnknown: true }); }
      await bounded(handoff, "Daemon ownership handoff is not confirmed");
    },
    rollback,
    release() { if (guard.connected) try { guard.disconnect(); } catch {} guard.unref(); },
  };
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
