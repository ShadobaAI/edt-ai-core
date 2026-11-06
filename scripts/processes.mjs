import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const lifecycles = new WeakMap();
export function launch(command, args = [], options = {}) {
  const { sessionOwned = true, ...spawnOptions } = options;
  const detached = spawnOptions.detached ?? process.platform !== "win32";
  const env = spawnOptions.env || process.env;
  const stdio = spawnOptions.stdio ?? "pipe";
  const child = spawn(sessionOwned ? process.execPath : command, sessionOwned ? [fileURLToPath(new URL("./process_supervisor.mjs", import.meta.url))] : args, {
    windowsHide: true,
    ...spawnOptions,
    ...(sessionOwned ? {
      env: Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== "NODE_OPTIONS")),
      stdio: [...(Array.isArray(stdio) ? stdio : [stdio, stdio, stdio]), "ipc"],
    } : {}),
    detached,
    shell: false,
  });
  const lifecycle = { supervised: sessionOwned, closed: false, stopping: null };
  lifecycles.set(child, lifecycle);
  child.once("close", () => { lifecycle.closed = true; });
  if (sessionOwned) {
    child.on("message", message => { if (message.error) child.emit("error", Object.assign(new Error(message.error.message), message.error)); });
    if (child.pid) child.send({ command, args, env }, error => {
      if (error && child.exitCode === null && child.signalCode === null) child.emit("error", error);
    });
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
  return lifecycle.stopping ||= terminate_child(child, lifecycle, grace);
}
async function terminate_child(child, lifecycle, grace) {
  if (lifecycle.closed) return;
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
  if (gone) return;
  // This handle was created by this session. Never kill by name or state-file PID.
  if (lifecycle.supervised) {
    if (child.connected) child.send({ stop: true }, () => {});
  } else child.kill("SIGKILL");
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
