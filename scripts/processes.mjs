import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { once } from "node:events";
import { own_windows_tree } from "./windows_process.mjs";
export function launch(command, args = [], options = {}) {
  const child = spawn(command, args, {
    windowsHide: true,
    detached: process.platform !== "win32",
    ...options,
    shell: false,
  });
  if (process.platform === "win32" && !options.detached && child.pid) {
    try {
      child.ownedJob = own_windows_tree(child.pid);
      child.once("close", () => child.ownedJob.close());
    } catch (error) {
      child.on("error", () => {});
      child.kill("SIGKILL");
      throw error;
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
export async function stop_child(child, grace = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close").catch(() => {});
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
  if (process.platform === "win32") {
    if (child.ownedJob) child.ownedJob.close();
    else child.kill("SIGKILL");
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  let killTimer;
  await Promise.race([
    closed,
    new Promise((done) => {
      killTimer = setTimeout(() => {
        if (process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else child.kill("SIGKILL");
        done();
      }, 2000);
    }),
  ]);
  clearTimeout(killTimer);
  if (child.exitCode === null && child.signalCode === null) {
    let finalTimer;
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        finalTimer = setTimeout(
          () => reject(new Error("Owned process termination is not confirmed")),
          2000,
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
