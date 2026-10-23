import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(new URL("../tools/without-shells.mjs", import.meta.url));

for (const status of [0, 17]) {
  test(`Node-only wrapper cleans its executable after child exit ${status}`, (t) => {
    const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "core runtime Юникод ")));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    // Use a writable source executable so a hard-link attempt would succeed.
    const source = path.join(temp, process.platform === "win32" ? "source.exe" : "source");
    fs.copyFileSync(process.execPath, source);
    if (process.platform !== "win32") fs.chmodSync(source, 0o755);
    const script = path.join(temp, "inspect.mjs");
    fs.writeFileSync(script, `
import fs from 'node:fs';
console.log(JSON.stringify({ executable: process.execPath, path: process.env.PATH,
  inode: String(fs.statSync(process.execPath, { bigint: true }).ino) }));
process.exitCode = ${status};
`);
    const result = spawnSync(source, [wrapper, script], {
      encoding: "utf8", windowsHide: true, shell: false, timeout: 30000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, status, result.stdout + result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(path.basename(observed.executable), process.platform === "win32" ? "node.exe" : "node");
    assert.equal(observed.path, path.dirname(observed.executable));
    if (process.platform === "win32") {
      assert.notEqual(observed.inode, String(fs.statSync(source, { bigint: true }).ino),
        "Windows Node-only runtime must be independent of the running source executable");
    }
    assert.equal(fs.existsSync(path.dirname(observed.executable)), false,
      "temporary runtime must be removed before the wrapper returns");
  });
}
