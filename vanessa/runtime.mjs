import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { digest, fail, readJson, startArguments, platformCommandLine, checkFiles, interactiveParameters } from "./profile.mjs";

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
const endpointKey = profile => `endpoint-${profile.mcp.port}`;
export const clientControlKey = profile => {
  const base = profile.client.infobase;
  const normalized = base.type === "file" ? { type: "file", path: process.platform === "win32" ? path.resolve(base.path).replace(/[\\/]+$/, "").toLowerCase() : path.resolve(base.path) }
    : { type: "server", server: base.server.toLowerCase(), database: base.database.toLowerCase() };
  return `client-${digest(JSON.stringify(normalized)).slice(0, 32)}`;
};
const clientKey = clientControlKey;
export function registryDir() { return path.join(os.tmpdir(), "vanessa-ui-control"); }

export async function withProfileLock(profile, use) {
  const root = registryDir(), files = [];
  fs.mkdirSync(root, { recursive: true });
  try {
    for (const key of [`profile-${profile.identity}`, endpointKey(profile), clientKey(profile)].sort()) {
      const file = path.join(root, `${key}.lock`);
      try { const fd = fs.openSync(file, "wx"); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, profile: profile.identity })); fs.closeSync(fd); files.push(file); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        let owner;
        try { owner = readJson(file, 4096); } catch { fail("unverifiable session lock; inspect it manually"); }
        if (!Number.isInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) fail("another UI control session holds this endpoint or TestClient");
        // Do not race another caller replacing a stale lock. Manual review only removes metadata.
        fail("stale UI control lock; verify no operation is running and remove only this lock file manually");
      }
    }
    return await use();
  } finally { for (const file of files.reverse()) fs.unlinkSync(file); }
}

export function checkOwner(profile, { required = false } = {}) {
  checkClaims(profile);
  const file = path.join(registryDir(), `${endpointKey(profile)}.owner.json`);
  if (!fs.existsSync(file)) { if (required) fail("endpoint is not owned by this profile; external managers are not adopted"); return null; }
  const owner = readJson(file, 4096);
  if (owner.profile !== profile.identity) fail("endpoint belongs to another profile");
  const { userEnv: clientUserEnv, computerName: clientComputer, ...clientCore } = profile.client;
  const priorClientSchemas = [clientCore, { ...clientCore, ...(clientUserEnv ? { userEnv: clientUserEnv } : {}) }];
  const compatibleClientDefaults = priorClientSchemas.some(client => owner.fingerprint === fingerprint({ ...profile, client }));
  if (owner.fingerprint !== fingerprint(profile) && !compatibleClientDefaults) {
    if (owner.status === "starting" || !Number.isInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) fail("profile launch settings changed; active or indeterminate manager ownership must be reviewed");
    // A confirmed dead, own process may be replaced with the current settings.
    // Its old claim is overwritten only after all new launch gates have passed.
  }
  return owner;
}
function fingerprint(profile) { return digest(JSON.stringify([profile.platform, profile.runtime, profile.manager, profile.client, profile.stateDir, interactiveParameters(profile)])); }
export function checkClaims(profile) {
  const root = registryDir();
  if (!fs.existsSync(root)) return;
  for (const file of fs.readdirSync(root).filter(file => file.endsWith(".owner.json"))) {
    const owner = readJson(path.join(root, file), 4096);
    const active = owner.status === "starting" || (owner.pid && alive(owner.pid));
    if (!active) continue;
    if (owner.profile === profile.identity && file !== `${endpointKey(profile)}.owner.json`) fail("this profile already owns a manager at another endpoint; launch settings changed");
    if (owner.profile !== profile.identity && (owner.clientKeyVersion !== 2 || owner.client === clientKey(profile))) fail("TestClient belongs to another active profile manager or its legacy client claim is unverified");
  }
}
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
function powershell(code, timeout = 10000) {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], {
    encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16384,
  });
  if (result.error || result.status !== 0) fail("Windows process operation failed; launch outcome may be indeterminate");
  return result.stdout.trim();
}
export function managerAlive(profile, owner) {
  if (!owner?.pid) return false;
  if (process.platform !== "win32") fail("manager process identity verification currently requires Windows");
  const output = powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(owner.pid)}'; if($p){$p | Select-Object ExecutablePath,CreationDate | ConvertTo-Json -Compress}`);
  if (!output) return false;
  let state;
  try { state = JSON.parse(output); } catch { fail("unverifiable manager process identity"); }
  if (state.ExecutablePath?.toLowerCase() !== profile.platform.toLowerCase() || state.CreationDate !== owner.created) fail("manager PID was reused or process identity changed");
  return true;
}
export const portAvailable = profile => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", error => error.code === "EADDRINUSE" ? resolve(false) : reject(new Error("cannot verify endpoint port availability")));
  server.listen({ host: new URL(profile.mcp.url).hostname.replace(/^\[|\]$/g, ""), port: profile.mcp.port, exclusive: true }, () => server.close(() => resolve(true)));
});

export async function start(profile) {
  if (process.platform !== "win32") fail("manager startup currently requires Windows");
  checkFiles(profile);
  return withProfileLock(profile, async () => {
    const owner = checkOwner(profile);
    if (owner && managerAlive(profile, owner)) {
      if (owner.clientKeyVersion !== 2) {
        const updated = { ...owner, client: clientKey(profile), clientKeyVersion: 2 };
        fs.writeFileSync(path.join(registryDir(), `${endpointKey(profile)}.owner.json`), JSON.stringify(updated));
      }
      return { status: "running", pid: owner.pid, ...(owner.startupLog ? { startupLog: owner.startupLog } : {}), readiness: "unverified" };
    }
    if (owner?.status === "starting") fail("previous launch outcome is indeterminate; verify manager state manually before restarting");
    if (!await portAvailable(profile)) fail("endpoint port is occupied; external managers are not adopted");
    fs.mkdirSync(profile.stateDir, { recursive: true });
    const stateFile = path.join(profile.stateDir, "manager.json");
    if (fs.existsSync(stateFile)) {
      const state = readJson(stateFile, 4096);
      if (state.profile !== profile.identity) fail("state directory belongs to another profile");
    }
    const startupLog = path.join(profile.stateDir, `startup-${randomUUID()}.log`);
    const claim = { profile: profile.identity, fingerprint: fingerprint(profile), client: clientKey(profile), clientKeyVersion: 2, startupLog, status: "starting" };
    // Reserve an explicit state directory before launch, also for different endpoints.
    if (!fs.existsSync(stateFile)) {
      const fd = fs.openSync(stateFile, "wx"); fs.writeFileSync(fd, JSON.stringify(claim)); fs.closeSync(fd);
    }
    fs.writeFileSync(path.join(profile.stateDir, "interactive.json"), JSON.stringify(interactiveParameters(profile), null, 2) + "\n");
    fs.mkdirSync(profile.results, { recursive: true });
    const ownerFile = path.join(registryDir(), `${endpointKey(profile)}.owner.json`);
    fs.writeFileSync(ownerFile, JSON.stringify(claim));
    // Start-Process joins ArgumentList. Preserve the platform's doubled quote contract.
    const commandLine = platformCommandLine(startArguments(profile, process.env, { startupLog }));
    // The user-visible interactive test manager needs its normal application window.
    // Only this short-lived PowerShell helper is hidden via windowsHide.
    let result;
    try {
      result = powershell(`$p=Start-Process -FilePath ${psQuote(profile.platform)} -ArgumentList ${psQuote(commandLine)} -WorkingDirectory ${psQuote(profile.projectRoot)} -WindowStyle Normal -PassThru; $s=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.Id); if(-not $s){throw 'manager exited'}; @{pid=$p.Id;created=$s.CreationDate}|ConvertTo-Json -Compress`);
    } catch (error) {
      error.code = "manager_launch_indeterminate";
      error.detail = { classification: "manager_start", outcome: "indeterminate", startupLog,
        nextAction: "Inspect this launch log and authoritative process state before another start; previous logs are preserved." };
      throw error;
    }
    let launched;
    try { launched = JSON.parse(result); } catch { fail("manager launch outcome is indeterminate; verify state before retry"); }
    if (!Number.isInteger(launched.pid) || !launched.created) fail("manager launch identity is indeterminate");
    const state = { ...claim, ...launched, status: "running" };
    fs.writeFileSync(ownerFile, JSON.stringify(state)); fs.writeFileSync(stateFile, JSON.stringify(state));
    return { status: "started", pid: state.pid, startupLog, diagnosticHint: "Inspect startupLog if the MCP endpoint does not become ready; previous logs are preserved.", readiness: "unverified" };
  });
}
