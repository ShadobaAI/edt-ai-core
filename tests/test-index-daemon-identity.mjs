import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fixture } from "./helpers.mjs";
import { daemon_owner_identity } from "../scripts/runtime.mjs";

test("daemon identity binds the executable and the actual loopback listener to its PID", async t => {
  const f = fixture(t), server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, owner = { pid: process.pid, executable: process.execPath }, daemon = { http_port: port };
  assert.ok(daemon_owner_identity(owner, daemon));
  const foreign = path.join(f.base, "foreign-executable"); fs.writeFileSync(foreign, "not this process");
  assert.equal(daemon_owner_identity({ ...owner, executable: foreign }, daemon), null);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  await once(child, "spawn");
  assert.equal(daemon_owner_identity({ pid: child.pid, executable: process.execPath }, daemon), null);
});
