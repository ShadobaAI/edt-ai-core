import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { run_tests } from "../tools/test-runner.mjs";
import { alive } from "../scripts/processes.mjs";
import { fixture } from "./helpers.mjs";

for (const pass of [true, false]) {
  test(`regression runner preserves a ${pass ? "passing" : "failing"} test's status`, async t => {
    const f = fixture(t), file = path.join(f.base, "verdict.mjs");
    fs.writeFileSync(file, `import test from 'node:test'; import assert from 'node:assert/strict';
      test('fixture',()=>assert.equal(${pass},true));`);
    assert.equal(await run_tests([file], { stdio: "ignore" }), pass ? 0 : 1);
  });
}

test("regression deadline releases a native-blocked test and its inherited descendants", { timeout: 15000 }, async t => {
  const f = fixture(t), file = path.join(f.base, "blocked.mjs"), pidsFile = path.join(f.base, "pids.json");
  fs.writeFileSync(file, `import test from 'node:test'; import fs from 'node:fs';
    import {spawn} from 'node:child_process'; import {once} from 'node:events';
    test('blocked fixture',async()=>{
      const child=spawn(process.execPath,['-e','process.send("ready"); setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
      await once(child,'message');
      fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify([process.pid,child.pid]));
      process.on('SIGTERM',()=>{}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
    });`);
  assert.equal(await run_tests([file], { timeout: 2500, stdio: "ignore" }), 1);
  const pids = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
  for (let i = 0; i < 100 && pids.some(alive); i++) await new Promise(resolve => setTimeout(resolve, 10));
  for (const pid of pids) assert.equal(alive(pid), false, `owned process ${pid} must have exited`);
  assert.equal(alive(process.pid), true);
});
