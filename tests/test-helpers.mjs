import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, node, success, ROOT } from "./helpers.mjs";
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
