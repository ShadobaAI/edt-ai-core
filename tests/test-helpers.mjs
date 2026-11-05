import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, node, node_async, success, ROOT } from "./helpers.mjs";
import { atomic_write } from "../scripts/common.mjs";

test("Windows atomic replacement retries transient sharing errors and preserves the old file on failure", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t), file = path.join(f.base, "atomic.txt"), rename = fs.renameSync;
  fs.writeFileSync(file, "old");
  let calls = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (++calls <= 2) throw Object.assign(new Error("busy"), { code: "EPERM" });
    return rename(from, to);
  });
  atomic_write(file, "new");
  assert.equal(calls, 3); assert.equal(fs.readFileSync(file, "utf8"), "new");
  t.mock.restoreAll(); calls = 0;
  t.mock.method(fs, "renameSync", () => { calls++; throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  assert.throws(() => atomic_write(file, "failed"), /denied/);
  assert.equal(calls, 6); assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(f.base).filter(name => name.startsWith(".core-")), []);
});

test("Node test helper accepts absolute fixture paths and anchors relative paths at the repository", t => {
  const f = fixture(t), file = path.join(f.base, "entry Юникод.mjs");
  fs.writeFileSync(file, "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));");
  const args = ["argument with spaces", "Юникод"];
  for (const entry of [file, path.relative(ROOT, file)]) {
    assert.deepEqual(success(node(entry, args, { cwd: f.root })), { cwd: f.root, args });
  }
});

test("async Node fixtures preserve stdin, arguments and cwd while timers keep running", async t => {
  const f = fixture(t), file = path.join(f.base, "async Юникод.mjs"), input = "input Юникод";
  fs.writeFileSync(file, `let input=''; for await (const chunk of process.stdin) input+=chunk;
    setTimeout(()=>console.log(JSON.stringify({input,cwd:process.cwd(),args:process.argv.slice(2)})),100);`);
  const args = ["argument with spaces", "Юникод"];
  for (const entry of [file, path.relative(ROOT, file)]) {
    let responsive = false;
    const timer = setTimeout(() => { responsive = true; }, 10);
    try {
      assert.deepEqual(success(await node_async(entry, args, { cwd: f.root, input })), { input, cwd: f.root, args });
      assert.equal(responsive, true);
    } finally { clearTimeout(timer); }
  }
});

test("async Node fixtures bound a process that ignores graceful termination", { timeout: 10000 }, async t => {
  const f = fixture(t), file = path.join(f.base, "blocked.mjs"), marker = path.join(f.base, "started");
  fs.writeFileSync(file, `import fs from 'node:fs'; process.on('SIGTERM',()=>{});
    fs.writeFileSync(${JSON.stringify(marker)},'ready'); setInterval(()=>{},1000);`);
  const result = await node_async(file, [], { timeout: 1000 });
  assert.equal(fs.existsSync(marker), true);
  assert.ok(result.error);
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGKILL");
});
