import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { dump, parse, stringify_yaml } from "../scripts/common.mjs";
import { patch_yaml_draft, SettingsBackend } from "../scripts/settings_backend.mjs";
import { environment, fixture } from "./helpers.mjs";

const scalars = [
  ["hello", '"hello"'], ["yes", '"yes"'], ["true", '"true"'],
  ["null", '"null"'], ["<<", '"<<"'], ["0.2", '"0.2"'], ["2020-01-02", '"2020-01-02"'],
  ["", '""'], ["a: # b", '"a: # b"'], ["строка\nстрока", '"строка\\nстрока"'],
  ["quote \" and \\ slash", '"quote \\\" and \\\\ slash"'],
  [true, "true"], [false, "false"], [null, "null"],
  [0, "0"], [-4, "-4"], [1.25, "1.25"], [1e-7, "1e-7"],
  [Infinity, ".inf"], [-Infinity, "-.inf"], [NaN, ".nan"],
  [[], "[]"], [{}, "{}"],
];

test("generated values have one YAML spelling for full documents and each field edit", t => {
  const f = fixture(t), file = path.join(f.base, "generated.yaml");
  for (const [value, spelling] of scalars) {
    const description = `${typeof value}: ${String(value)}`;
    const whole = `value: ${spelling}\n`;
    assert.equal(stringify_yaml({ value }), whole, description);
    dump({ value }, file);
    assert.equal(fs.readFileSync(file, "utf8"), whole, description);
    const sources = [
      ["value: old # keep\n", { kind: "set", path: ["value"], value }, `value: ${spelling} # keep\n`],
      ["root:\n  keep: old # comment\n", { kind: "set", path: ["root", "value"], value }, `root:\n  keep: old # comment\n  value: ${spelling}\n`],
      ["root: {keep: old}\n", { kind: "set", path: ["root", "value"], value }, `root: {keep: old, value: ${spelling}}\n`],
      ["items:\n  - old\n", { kind: "append", path: ["items", 1], value }, `items:\n  - old\n  - ${spelling}\n`],
      ["items: [old]\n", { kind: "append", path: ["items", 1], value }, `items: [old, ${spelling}]\n`],
    ];
    for (const [source, operation, expected] of sources) {
      const result = patch_yaml_draft(source, operation).text;
      assert.equal(result, expected, description);
      const data = parse(result);
      const actual = operation.kind === "append" ? data.items[1] : operation.path.length === 1 ? data.value : data.root.value;
      assert.deepEqual(actual, value, description);
    }
  }
});

test("generated collections use YAML block or flow syntax for their context", () => {
  const value = { name: "yes", enabled: false, count: 4, nothing: null, list: ["true", 0, { text: "line\nline" }] };
  const before = { root: { keep: "old" }, tail: "ok" };
  const after = { root: { keep: "old", value }, tail: "ok" };
  const added = patch_yaml_draft(stringify_yaml(before), { kind: "set", path: ["root", "value"], value }).text;
  assert.equal(added, stringify_yaml(after));
  const replaced = patch_yaml_draft(added, { kind: "set", path: ["root", "value"], value: { ...value, name: "next" } }).text;
  assert.equal(replaced, stringify_yaml({ root: { keep: "old", value: { ...value, name: "next" } }, tail: "ok" }));
  const appended = patch_yaml_draft('items:\r\n  - "old" # keep\r\n', { kind: "append", path: ["items", 1], value }).text;
  assert.equal(appended, `items:\r\n  - "old" # keep\r\n${stringify_yaml([value]).replace(/\n$/, "").split("\n").map(line => "  " + line).join("\r\n")}\r\n`);
  const flow = patch_yaml_draft("root: {keep: old}\n", { kind: "set", path: ["root", "value"], value }).text;
  assert.equal(flow, 'root: {keep: old, value: { name: "yes", enabled: false, count: 4, nothing: null, list: [ "true", 0, { text: "line\\nline" } ] }}\n');
  assert.deepEqual(parse(flow).root.value, value);
});

test("field edits preserve aliases, comments and YAML 1.1 ambiguous keys", () => {
  const source = 'defaults: &a1\n  value: old\ncopy:\n  <<: *a1\nlist:\n  - one # keep\nafter: *a1\n';
  const merged = patch_yaml_draft(source, { kind: "set", path: ["copy", "value"], value: "yes" }).text;
  assert.match(merged, /value: "yes"/);
  assert.deepEqual(parse(merged).copy, { value: "yes" });
  const shared = { value: "new" };
  const added = patch_yaml_draft(source, { kind: "append", path: ["list", 1], value: [shared, shared] }).text;
  assert.equal((added.match(/&a1/g) || []).length, 1);
  assert.deepEqual(parse(added).after, { value: "old" });
  assert.match(added, /# keep/);
  const ambiguous = patch_yaml_draft("root:\n  keep: old\n", { kind: "set", path: ["root", "yes"], value: "no" }).text;
  assert.match(ambiguous, /"yes": "no"/);
  assert.equal(parse(ambiguous).root.yes, "no");
  for (const value of ["yes", "<<", false, 3, null, { name: "yes", count: 3 }]) {
    const edited = patch_yaml_draft("items: [old, # keep\n  more]\n", { kind: "append", path: ["items", 2], value }).text;
    assert.match(edited, /# keep/);
    assert.deepEqual(parse(edited).items[2], value);
    if (typeof value === "string") assert.ok(edited.includes(JSON.stringify(value)));
  }
  for (const source of ["root:\n  keep: old\n", "root: {keep: old}\n"]) {
    const literal = patch_yaml_draft(source, { kind: "set", path: ["root", "<<"], value: "<<" }).text;
    assert.match(literal, /"<<": "<<"/);
    assert.equal(parse(literal).root["<<"], "<<");
  }
  assert.deepEqual(parse(stringify_yaml({ nested: { "<<": "<<" } })), { nested: { "<<": "<<" } });
  const mergedLiteral = patch_yaml_draft(source, { kind: "set", path: ["copy", "value"], value: "<<" }).text;
  assert.match(mergedLiteral, /<<: \*a1/);
  assert.match(mergedLiteral, /value: "<<"/);
  assert.equal(parse(mergedLiteral).copy.value, "<<");
  const overridden = 'defaults: &base\n  value: old\ncopy:\n  <<: *base\n  value: newer\n  "<<": "<<"\n';
  const restored = patch_yaml_draft(overridden, { kind: "remove", path: ["copy", "value"] }).text;
  assert.deepEqual(parse(restored).copy, { value: "old", "<<": "<<" });
  const replacement = patch_yaml_draft('value: "# old" # keep\n', { kind: "set", path: ["value"], value: { text: "yes" } }).text;
  assert.equal(replacement, 'value: { text: "yes" } # keep\n');
  assert.deepEqual(parse(replacement).value, { text: "yes" });
});

test("new settings, subsequent updates and generated exports use identical YAML", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  const settings = { edtUrl: "http://127.0.0.1:18080/mcp", openvikingTimeout: 7, bslLsJava: "java", bslLsEnabled: false };
  await backend.update_scoped(settings, "project_local");
  const file = path.join(f.root, ".ai/project.local.yaml"), initial = fs.readFileSync(file, "utf8");
  assert.match(initial, /url: "http:\/\/127\.0\.0\.1:18080\/mcp"/);
  assert.match(initial, /timeout_seconds: 7/);
  assert.match(initial, /java: "java"/);
  assert.match(initial, /enabled: false/);
  await backend.update_scoped({ edtUrl: "http://127.0.0.1:18081/mcp", openvikingTimeout: 9, bslLsJava: "other-java", bslLsEnabled: true }, "project_local");
  await backend.update_scoped(settings, "project_local");
  assert.equal(fs.readFileSync(file, "utf8"), initial);
  const exported = await backend.main({ action: "transfer_export", scope: "project_local" });
  assert.equal(exported.text, initial);
});
