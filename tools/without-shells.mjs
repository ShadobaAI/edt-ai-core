// Run source tests/build with only Node on PATH. Git is mapped to its explicit
// developer installation for version metadata and isolated publication fixtures.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { which } from "../scripts/processes.mjs";
const temp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "core no shells ")),
);
try {
  const node = path.join(
    temp,
    process.platform === "win32" ? "node.exe" : "node",
  );
  // A hard link can stay locked by this still-running Node process on Windows.
  if (process.platform === "win32") {
    fs.copyFileSync(process.execPath, node);
  } else {
    try {
      fs.linkSync(process.execPath, node);
    } catch {
      fs.copyFileSync(process.execPath, node);
    }
  }
  if (process.platform !== "win32") fs.chmodSync(node, 0o755);
  const preload = path.join(temp, "guard.mjs");
  fs.writeFileSync(
    preload,
    `import cp from 'node:child_process'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) { const original=cp[name]; cp[name]=function(command,...args) { const options=args.find(value=>value&&typeof value==='object'&&!Array.isArray(value))||{}; if(name==='exec'||name==='execSync'||options.shell||/^(python[0-9.]*|py|powershell|pwsh|bash|sh)(?:\\.exe|\\.cmd)?$/i.test(path.basename(String(command)))) throw new Error('Forbidden runtime: '+command); if(command==='git')command=process.env.CORE_GIT_EXECUTABLE; return original.call(this,command,...args); }; } syncBuiltinESMExports();`,
  );
  const result = spawnSync(node, process.argv.slice(2), {
    env: {
      ...process.env,
      PATH: temp,
      NODE_OPTIONS: "--import " + pathToFileURL(preload).href,
      CORE_GIT_EXECUTABLE: which("git") || "",
    },
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
