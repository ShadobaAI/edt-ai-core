import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, node, success, ROOT } from "./helpers.mjs";

test("Node test helper accepts absolute fixture paths and anchors relative paths at the repository", t => {
  const f = fixture(t), file = path.join(f.base, "entry Юникод.mjs");
  fs.writeFileSync(file, "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));");
  const args = ["argument with spaces", "Юникод"];
  for (const entry of [file, path.relative(ROOT, file)]) {
    assert.deepEqual(success(node(entry, args, { cwd: f.root })), { cwd: f.root, args });
  }
});
