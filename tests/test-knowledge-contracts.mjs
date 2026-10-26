import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { stringify } from "../vendor/deps.mjs";
import { check_schema, load, dump, validate_settings, ROOT } from "../scripts/common.mjs";
import { sha256 } from "../scripts/project_paths.mjs";
import { validate, validate_at, project_profile } from "../scripts/profile.mjs";
import { fixture, environment, node } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { validate_manifest, validate_material, validate_publication_receipt, parse_material, load_manifest, search_requirements, SEARCH_REQUIREMENTS, publication_inventory } from "../scripts/knowledge.mjs";

const manifest = () => ({ schema_version: "0.1", kind: "catalog", provider: "openviking",
  collections: [{ id: "architecture", description: "Architecture" }], materials: [] });
const entry = () => ({ id: "design", collection: "architecture", path: "docs/design.md", sha256: "a".repeat(64) });
const material = () => ({ schema_version: "0.1", kind: "document", id: "design", title: "Architecture",
  provenance: { source: "https://example.org/design", description: "Reviewed design" },
  scope: ["Example subsystem"], revision: "edition-1", compatibility: { project_revision: "reviewed-revision" }, status: "published" });
const card = () => ({ ...material(), kind: "api_card", status: "confirmed", intent: ["Choose a supported mechanism"],
  recommended_api: "ExampleModule.ExampleMethod", recommendation: "use", when_to_use: ["Within the reviewed scope"],
  when_not_to_use: ["Outside the reviewed scope"], contract: "Argument: value; result: value; no persistent effects.",
  context: ["Server; caller has read access"], verification_ref: "https://example.org/reviews/1", verified_at: "2026-10-24" });
const receipt = () => ({ schema_version: "0.2", provider: "openviking", server: { endpoint: "https://example.org/mcp", scope: "team" },
  collections: ["architecture"], publication_revision: "b".repeat(40), manifest_sha256: "a".repeat(64), index_revision: "snapshot-1",
  collection_snapshots: [{ ...publication_inventory(manifest(), ["architecture"])[0], root: "viking://resources/team/architecture" }],
  verification: { git_manifest: "matched_committed_bytes", index_contents: "exact_active_manifest", excluded_materials: "absent",
    deleted_materials: "absent", changed_materials: "matched", delivery: "immutable_endpoint", deployment_id: "fixture-deployment" },
  verified_at: "2026-10-24T08:00:00Z", expires_at: "2026-10-25T08:00:00Z", evidence_ref: "https://example.org/publications/1" });
const profile = () => {
  const data = load(path.join(ROOT, "profiles/generic-1c/profile.yaml"));
  data.knowledge = { provider: "openviking", mode: "transitional", manifest: null,
    collections: ["architecture"], required: false, dependent_actions: [] };
  return data;
};
function catalog_fixture(t, metadata = material()) {
  const f = fixture(t), corpus = path.join(f.root, "knowledge"), data = manifest();
  fs.mkdirSync(path.join(corpus, "docs"), { recursive: true });
  const target = path.join(corpus, "docs/design.md");
  data.materials = [entry()];
  f.profile.knowledge = profile().knowledge; f.profile.knowledge.manifest = "knowledge/catalog.yaml";
  const write = (meta = metadata, text = "---\n" + stringify(meta, { schema: "yaml-1.1" }) + "---\n# Reviewed material\n") => {
    fs.writeFileSync(target, text);
    data.materials[0].sha256 = sha256(fs.readFileSync(target));
    dump(data, path.join(corpus, "catalog.yaml"));
  };
  write();
  return { ...f, corpus, target, data, write, read: () => load_manifest(f.root, f.profile.knowledge.manifest, ["architecture"]) };
}

test("manifest defines a selected catalog without requiring every recommended collection", () => {
  validate_manifest(manifest(), ["architecture"]);
  validate_manifest(load(path.join(ROOT, "knowledge/recommended-manifest.yaml")));
  assert.throws(() => validate_manifest(manifest(), ["bsp"]), /Unknown selected/);
  const data = manifest(); data.materials.push(entry()); validate_manifest(data);
  for (const patch of [{ provider: "none" }, { kind: "unknown" }, { schema_version: "1.0" }, { unexpected: true }])
    assert.throws(() => validate_manifest({ ...data, ...patch }));
  data.kind = "recommendations"; assert.throws(() => validate_manifest(data), /materials/);
});

test("manifest rejects ambiguous collections, entries and unsafe portable paths", () => {
  for (const collection of ["", " ", "../team", "Team", "a".repeat(65)]) {
    const data = manifest(); data.collections[0].id = collection;
    assert.throws(() => validate_manifest(data));
  }
  const duplicate = manifest(); duplicate.collections.push({ ...duplicate.collections[0] });
  assert.throws(() => validate_manifest(duplicate), /unique/);
  for (const patch of [{ id: "../item" }, { collection: "missing" }, { sha256: "invalid" },
    ...["../file.md", "/file.md", "C:/file.md", "dir/../file.md", "dir\\file.md", "file.md?x", "file.md#x", "dir/%2e%2e/file.md"].map(path => ({ path }))]) {
    const data = manifest(); data.materials = [{ ...entry(), ...patch }];
    assert.throws(() => validate_manifest(data));
  }
  for (const patch of [{ id: "other" }, { path: "other.md" }]) {
    const data = manifest(); data.materials = [entry(), { ...entry(), ...patch }];
    assert.throws(() => validate_manifest(data), /unique/);
  }
});

test("profile search requirements are bounded and never relax publication or read access", () => {
  const data = profile(); validate(data);
  assert.deepEqual(search_requirements(data), SEARCH_REQUIREMENTS);
  data.knowledge.search = { ...SEARCH_REQUIREMENTS, max_results: 5 }; validate(data);
  assert.equal(search_requirements(data).max_results, 5);
  for (const patch of [{ publication: "any" }, { snapshot: "mixed" }, { access: "write" }, { max_results: 0 },
    { max_results: 101 }, { max_excerpt_chars: 8001 }, { max_material_chars: 100001 }, { arbitrary: true }])
    assert.throws(() => validate({ ...data, knowledge: { ...data.knowledge, search: { ...data.knowledge.search, ...patch } } }));
  const disabled = load(path.join(ROOT, "profiles/generic-1c/profile.yaml"));
  assert.equal(search_requirements(disabled), null);
  disabled.knowledge.manifest = "catalog.yaml"; assert.throws(() => validate(disabled));
});

test("material metadata requires provenance, explicit scope, edition, compatibility and status", () => {
  const data = material(); assert.equal(validate_material(data), data);
  for (const key of ["schema_version", "kind", "id", "title", "provenance", "scope", "revision", "compatibility", "status"]) {
    const incomplete = structuredClone(data); delete incomplete[key];
    assert.throws(() => validate_material(incomplete), undefined, key);
  }
  for (const patch of [{ provenance: {} }, { provenance: { source: " " } }, { scope: [] }, { scope: [" "] },
    { scope: ["same", "same"] }, { revision: "" }, { compatibility: {} }, { compatibility: { bsp: " " } },
    { compatibility: { "bad key": "1.0" } }, { status: "confirmed" }, { unknown: true }])
    assert.throws(() => validate_material({ ...data, ...patch }));
  for (const status of ["draft", "published", "obsolete"]) validate_material({ ...data, status });
});

test("documents and API cards have separate statuses and required contracts", () => {
  validate_material(material()); validate_material(card());
  for (const key of ["intent", "recommended_api", "recommendation", "when_to_use", "when_not_to_use", "contract", "context", "verification_ref", "verified_at"]) {
    const incomplete = card(); delete incomplete[key];
    assert.throws(() => validate_material(incomplete), undefined, key);
    assert.throws(() => validate_material({ ...material(), [key]: card()[key] }), undefined, key);
  }
  for (const status of ["confirmed", "review_required", "obsolete"]) validate_material({ ...card(), status });
  for (const status of ["draft", "published"]) assert.throws(() => validate_material({ ...card(), status }));
  for (const patch of [{ intent: [] }, { contract: " " }, { context: [] }, { when_not_to_use: [] }, { recommendation: "avoid" }, { verified_at: "today" }])
    assert.throws(() => validate_material({ ...card(), ...patch }));
  validate_material({ ...card(), recommendation: "avoid", avoid_reason: "Retained for existing callers only" });
});

test("profile loading validates the complete manifest, exact file bytes and metadata references", t => {
  const f = catalog_fixture(t, card());
  const metadata = card(); metadata.provenance.source = "sources/original.md#contract";
  metadata.verification_ref = "reviews/verification.md#L1";
  for (const relative of ["sources/original.md", "reviews/verification.md"]) {
    fs.mkdirSync(path.dirname(path.join(f.corpus, relative)), { recursive: true });
    fs.writeFileSync(path.join(f.corpus, relative), "# Evidence\n");
  }
  f.write(metadata); f.save();
  const result = f.read();
  assert.equal(result.materials[0].metadata.kind, "api_card");
  assert.equal(result.sha256, sha256(fs.readFileSync(path.join(f.corpus, "catalog.yaml"))));
  assert.deepEqual(project_profile(f.root), f.profile);
  fs.appendFileSync(f.target, "Changed\n");
  assert.throws(() => project_profile(f.root), /SHA-256 mismatch/);
});

test("manifest validation rejects missing, malformed, unpublished and mismatched materials", t => {
  const f = catalog_fixture(t);
  for (const metadata of [{ ...material(), id: "different" }, { ...material(), unexpected: true },
    { ...material(), status: "draft" }, { ...material(), status: "obsolete" }, { ...card(), status: "obsolete" }]) {
    f.write(metadata); assert.throws(() => f.read());
  }
  for (const text of ["# No metadata\n", "---\nid: design\n---\nBody\n", "---\na: 1\na: 2\n---\nBody\n"]) {
    f.write(null, text); assert.throws(() => f.read());
  }
  f.write(); fs.rmSync(f.target); assert.throws(() => f.read(), /missing/);
  fs.mkdirSync(f.target); assert.throws(() => f.read(), /regular file/);
  assert.throws(() => load_manifest(f.root, "knowledge/missing.yaml"), /missing/);
});

test("references accept explicit web and contained file targets without network requests", t => {
  const f = catalog_fixture(t), network = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network"); });
  for (const ref of ["https://example.org/source#symbol", "http://127.0.0.1:1/source", "#local", "docs/design.md#heading"]) {
    f.write({ ...material(), provenance: { source: ref } }); f.read();
  }
  for (const ref of ["javascript:alert(1)", "file:///C:/source", "https://user:secret@example.org/source", "https://example.org/\nsource",
    "https://example.org:0/source", "../outside.md", "/outside.md", "C:/source.md", "dir\\source.md", "dir/%2e%2e/source.md", "docs/design.md#", "https://example.org/#", "#a#b"]) {
    assert.throws(() => validate_material({ ...material(), provenance: { source: ref } }), undefined, ref);
    assert.throws(() => validate_material({ ...card(), verification_ref: ref }), undefined, ref);
  }
  f.write({ ...material(), provenance: { source: "missing.md" } }); assert.throws(() => f.read(), /missing/);
  assert.equal(network.mock.callCount(), 0);
});

test("front matter is strict YAML and verification dates must be real calendar dates", () => {
  const text = "\uFEFF---\r\n" + stringify(material(), { schema: "yaml-1.1" }).replaceAll("\n", "\r\n") + "---\r\nBody\r\n";
  assert.deepEqual(parse_material(text), material());
  assert.throws(() => parse_material(text.replace("Body", " ")), /nonempty/);
  for (const verified_at of ["2026-02-29", "2026-13-01", "2026-00-01", "2026-01-32"])
    assert.throws(() => validate_material({ ...card(), verified_at }), /calendar date/);
  validate_material({ ...card(), verified_at: "2024-02-29" });
});

test("portable paths and filesystem containment also reject junctions, aliases and device names", t => {
  const f = catalog_fixture(t), outside = path.join(f.base, "outside"); fs.mkdirSync(outside);
  for (const relative of ["../catalog.yaml", "C:/catalog.yaml", "//server/share/catalog.yaml", "knowledge/catalog.yaml:stream", "knowledge/./catalog.yaml", "knowledge//catalog.yaml", "knowledge/CON.yaml", "knowledge/dir./catalog.yaml"]) {
    assert.throws(() => load_manifest(f.root, relative));
  }
  for (const relative of ["docs/CON.md", "docs/NUL.md", "docs/dir./design.md", "docs//design.md", "docs/LPT1.md"]) {
    const data = manifest(); data.materials = [{ ...entry(), path: relative }];
    assert.throws(() => validate_manifest(data));
  }
  fs.symlinkSync(outside, path.join(f.corpus, "linked"), process.platform === "win32" ? "junction" : "dir");
  f.data.materials[0].path = "linked/design.md"; dump(f.data, path.join(f.corpus, "catalog.yaml"));
  assert.throws(() => f.read(), /escapes project/);
  f.data.materials[0].path = "docs/design.md";
  f.write({ ...material(), provenance: { source: "linked/source.md" } });
  assert.throws(() => validate_at(f.root, f.profile), /escapes project/);
  f.write();
  fs.linkSync(f.target, path.join(f.corpus, "docs/alias.md"));
  f.data.materials.push({ ...entry(), id: "alias", path: "docs/alias.md", sha256: f.data.materials[0].sha256 });
  dump(f.data, path.join(f.corpus, "catalog.yaml")); assert.throws(() => f.read(), /same file/);
  fs.symlinkSync(outside, path.join(f.root, "external"), process.platform === "win32" ? "junction" : "dir");
  f.profile.knowledge.manifest = "external/catalog.yaml"; assert.throws(() => validate_at(f.root, f.profile), /escapes project/);
});

test("recommendation lists and unknown selected collections cannot masquerade as a catalog", t => {
  const f = catalog_fixture(t);
  assert.throws(() => load_manifest(f.root, "knowledge/catalog.yaml", ["unknown"]), /Unknown selected/);
  f.data.kind = "recommendations"; f.data.materials = []; dump(f.data, path.join(f.corpus, "catalog.yaml"));
  assert.throws(() => f.read(), /recommendations manifest/);
});

test("distinct 64-bit file identities do not collide through Number rounding", t => {
  const f = catalog_fixture(t), second = path.join(f.corpus, "docs/second.md");
  fs.writeFileSync(second, "---\n" + stringify({ ...material(), id: "second" }, { schema: "yaml-1.1" }) + "---\nSecond material\n");
  f.data.materials.push({ ...entry(), id: "second", path: "docs/second.md", sha256: sha256(fs.readFileSync(second)) });
  dump(f.data, path.join(f.corpus, "catalog.yaml"));
  const original = fs.statSync, identities = new Map([[f.target, 9007199254740992n], [second, 9007199254740993n]]);
  t.mock.method(fs, "statSync", (file, options) => {
    const stat = original(file, options), id = identities.get(file);
    return id === undefined ? stat : { ...stat, isFile: () => stat.isFile(), ino: options?.bigint ? id : Number(id) };
  });
  assert.equal(f.read().materials.length, 2);
});

test("versioned contracts reject missing, legacy, future and incorrectly typed versions explicitly", () => {
  const cases = [
    ["schema_version", profile(), validate, "0.2"],
    ["version", load(path.join(ROOT, "settings/defaults.json")), validate_settings, "0.1.0"],
    ["schema_version", manifest(), validate_manifest, "0.1"],
    ["schema_version", material(), validate_material, "0.1"],
    ["schema_version", receipt(), validate_publication_receipt, "0.2"],
  ];
  for (const [field, data, check, expected] of cases) {
    check(data);
    for (const value of [undefined, "0.0", "99.0", 0.1, null]) {
      const bad = structuredClone(data);
      if (value === undefined) delete bad[field]; else bad[field] = value;
      assert.throws(() => check(bad), error => error.code === "UNSUPPORTED_CONTRACT_VERSION" && error.expectedVersion === expected && error.message.includes("expected"));
    }
  }
  const old = profile(); old.schema_version = "0.1";
  assert.throws(() => validate(old), error => error.code === "UNSUPPORTED_CONTRACT_VERSION");
  assert.equal(old.schema_version, "0.1");
  check_schema({ connections: {} }, "project-local.schema.json"); // Existing unversioned, unchanged partial overrides remain supported.
  check_schema({ schema_version: "0.1" }, "project-local.schema.json");
  assert.throws(() => check_schema({ schema_version: "9.0" }, "project-local.schema.json"), error => error.code === "UNSUPPORTED_CONTRACT_VERSION");
});

test("publication receipt is a strict declaration tied to server, scope, manifest and snapshot", () => {
  validate_publication_receipt(receipt());
  validate_publication_receipt({ ...receipt(), publication_revision: "f".repeat(64), verified_at: "2026-10-24T08:00:00.000Z" });
  for (const field of Object.keys(receipt())) {
    const bad = receipt(); delete bad[field]; assert.throws(() => validate_publication_receipt(bad), undefined, field);
  }
  for (const patch of [{ ready: true }, { publication_revision: "HEAD" }, { manifest_sha256: "wrong" },
    { server: { endpoint: "https://user:secret@example.org/mcp", scope: "team" } }, { collections: [] },
    { collections: ["architecture", "architecture"] }, { index_revision: " " }, { verified_at: "2026-02-29T08:00:00Z" },
    { expires_at: "2026-10-24T08:00:00Z" }, { expires_at: "2026-10-23T08:00:00Z" }, { evidence_ref: "file:///C:/receipt" }])
    assert.throws(() => validate_publication_receipt({ ...receipt(), ...patch }));
});

test("publication inventory covers exact selected active sets, independently of catalog ordering", () => {
  const data = manifest(); data.collections.push({ id: "empty", description: "Empty" });
  data.materials = [entry(), { ...entry(), id: "second", path: "docs/second.md", sha256: "b".repeat(64) }];
  const inventory = publication_inventory(data, ["empty", "architecture"]);
  assert.equal(inventory[0].material_count, 2);
  assert.equal(inventory[1].materials_sha256, sha256("[]"));
  assert.deepEqual(publication_inventory({ ...data, materials: [...data.materials].reverse() }, ["architecture", "empty"]), inventory);
  for (const materials of [[], data.materials.slice(0, 1), data.materials.map(item => ({ ...item, sha256: "c".repeat(64) }))])
    assert.notDeepEqual(publication_inventory({ ...data, materials }, ["architecture", "empty"]), inventory);
  const valid = receipt();
  for (const patch of [{ collection_snapshots: [] }, { collection_snapshots: [valid.collection_snapshots[0], valid.collection_snapshots[0]] },
    { collection_snapshots: [{ ...valid.collection_snapshots[0], root: "viking://resources/team/../private" }] },
    { verification: { ...valid.verification, index_contents: "partial" } }, { verification: { ...valid.verification, delivery: "mutable_endpoint" } }])
    assert.throws(() => validate_publication_receipt({ ...valid, ...patch }));
});

test("plugin release, knowledge Git revision and material edition remain independent", () => {
  const published = receipt();
  for (const field of ["publication_revision", "git_commit", "plugin_version", "index_revision"])
    assert.throws(() => validate_manifest({ ...manifest(), [field]: published.publication_revision }));
  for (const field of ["plugin_version", "core_version"])
    assert.throws(() => validate_publication_receipt({ ...published, [field]: "1.2.3" }));
  validate_material({ ...material(), revision: "independent-document-edition" });
  validate_publication_receipt({ ...published, publication_revision: "c".repeat(40) });
  assert.deepEqual(publication_inventory(manifest(), ["architecture"]), publication_inventory(manifest(), published.collections));
  assert.throws(() => validate_publication_receipt({ ...published, publication_revision: "1.2.3" }));
});

test("profile CLI and settings preview reject an old contract without changing saved bytes", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const target = path.join(f.root, ".ai/project.yaml"), before = fs.readFileSync(target), old = structuredClone(f.profile);
  old.schema_version = "0.1";
  const input = path.join(f.base, "old.yaml"); dump(old, input);
  const result = node("scripts/profile.mjs", ["import", f.root, "--input", input, "--replace"], { env: f.env });
  assert.equal(result.status, 1); assert.match(result.stdout, /Unsupported contract version/);
  const backend = new SettingsBackend();
  await assert.rejects(backend.main({ action: "preview", text: JSON.stringify(old) }), error => error.code === "UNSUPPORTED_CONTRACT_VERSION");
  for (const version of [undefined, 0, 2, "1"]) {
    await assert.rejects(backend.main({ action: "preview", text: JSON.stringify({ format: "1c-ai-core-settings", version, profile: f.profile }) }), /версия/);
  }
  assert.deepEqual(fs.readFileSync(target), before);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["project.yaml"]);
  assert.equal(fs.existsSync(f.env.EDT_AI_SETTINGS), false);
});
