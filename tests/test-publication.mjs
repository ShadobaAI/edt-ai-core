import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { stable } from "../scripts/common.mjs";
import { environment } from "./helpers.mjs";
import { sha256 } from "../scripts/project_paths.mjs";
import { publication_inventory } from "../scripts/knowledge.mjs";
import { match_publication_receipt, publication_entry, verify_publication_material, PublicationConfirmation, publication_revision } from "../scripts/openviking_publication.mjs";

const now = Date.parse("2026-10-26T08:00:00Z");
const keys = generateKeyPairSync("ed25519");
const signed = payload => ({ payload, signature: sign(null, Buffer.from(stable(payload)), keys.privateKey).toString("base64") });
function trust(t, receipts) {
  environment(t, { ...process.env, EDT_AI_OPENVIKING_PUBLICATION_PUBLIC_KEY: keys.publicKey.export({ type: "spki", format: "pem" }),
    EDT_AI_OPENVIKING_PUBLICATION_RECEIPTS: JSON.stringify(receipts) });
}
function fixture() {
  const metadata = { schema_version: "0.1", kind: "document", id: "design", title: "Design",
    provenance: { source: "https://example.org/source" }, scope: ["Fixture"], revision: "edition-1",
    compatibility: { fixture: "1" }, status: "published" };
  const text = "---\n" + JSON.stringify(metadata) + "\n---\n# Design\n";
  const data = { schema_version: "0.1", kind: "catalog", provider: "openviking",
    collections: [{ id: "architecture", description: "Design" }, { id: "empty", description: "Empty" }],
    materials: [{ id: "design", collection: "architecture", path: "design.md", sha256: sha256(text) }] };
  const manifest = { data, sha256: sha256(JSON.stringify(data)) };
  const collections = new Map([["architecture", "viking://resources/team/architecture"], ["empty", "viking://resources/team/empty"]]);
  const expected = { endpoint: "https://example.org/mcp", scope: "viking://resources/team", deploymentId: "deployment-1", manifest, collections };
  const receipt = { schema_version: "0.2", provider: "openviking", server: { endpoint: expected.endpoint, scope: expected.scope },
    collections: [...collections.keys()], publication_revision: "a".repeat(40), manifest_sha256: manifest.sha256, index_revision: "index-1",
    collection_snapshots: publication_inventory(data, [...collections.keys()]).map(item => ({ ...item, root: collections.get(item.collection) })),
    verification: { git_manifest: "matched_committed_bytes", index_contents: "exact_active_manifest", excluded_materials: "absent",
      deleted_materials: "absent", changed_materials: "matched", delivery: "immutable_endpoint", deployment_id: expected.deploymentId },
    verified_at: "2026-10-26T07:00:00Z", expires_at: "2026-10-26T09:00:00Z", evidence_ref: "https://example.org/publication/1" };
  return { expected, receipt, text, uri: collections.get("architecture") + "/design.md" };
}

test("publication match rejects missing, expired, mixed and stale declarations", () => {
  const f = fixture();
  assert.equal(match_publication_receipt(f.receipt, f.expected, now), f.receipt);
  assert.throws(() => match_publication_receipt(null, f.expected, now));
  for (const patch of [{ manifest_sha256: "f".repeat(64) }, { collections: ["architecture"] },
    { verified_at: "2026-10-26T08:01:00Z" }, { expires_at: "2026-10-26T08:00:00Z" }, { expires_at: "2026-10-28T08:00:00Z" },
    { server: { ...f.receipt.server, endpoint: "https://other.example/mcp" } }, { server: { ...f.receipt.server, scope: "another-team" } },
    { verification: { ...f.receipt.verification, deployment_id: "another-deployment" } },
    { collection_snapshots: f.receipt.collection_snapshots.map(item => ({ ...item, material_count: item.material_count + 1 })) },
    { collection_snapshots: f.receipt.collection_snapshots.map(item => ({ ...item, materials_sha256: "f".repeat(64) })) },
    { collection_snapshots: f.receipt.collection_snapshots.map(item => ({ ...item, root: item.root + "/other" })) }])
    assert.throws(() => match_publication_receipt({ ...f.receipt, ...patch }, f.expected, now));
  assert.throws(() => match_publication_receipt(f.receipt, { ...f.expected,
    manifest: { ...f.expected.manifest, data: { ...f.expected.manifest.data, materials: [] } } }, now), /inventory/);
  assert.throws(() => match_publication_receipt({ ...f.receipt, collection_snapshots: f.receipt.collection_snapshots.map(item =>
    ({ ...item, root: "viking://resources/team/architecture" + (item.collection === "empty" ? "/nested" : "") })) }, f.expected, now), /overlap/);
});

test("publication retrieval rejects excluded, deleted, changed and partial materials", () => {
  const f = fixture(), read = { uri: f.uri, collection: "architecture", text: f.text };
  assert.equal(verify_publication_material(f.receipt, f.expected.manifest, read).id, "design");
  for (const patch of [{ uri: f.uri.replace("design.md", "deleted.md") }, { collection: "empty" },
    { text: f.text + "Changed" }, { text: f.text.replaceAll("\n", "\r\n") }, { partial: true }])
    assert.throws(() => verify_publication_material(f.receipt, f.expected.manifest, { ...read, ...patch }));
  assert.throws(() => publication_entry(f.receipt, f.expected.manifest, f.uri + "/../design.md", "architecture"));
  const changed = structuredClone(f.expected.manifest);
  changed.data.materials[0].sha256 = sha256(f.text + "New edition");
  assert.throws(() => verify_publication_material(f.receipt, changed, { ...read, text: f.text + "New edition" }), /inventory/);
  for (const text of [f.text.replace('"id":"design"', '"id":"other"'), f.text.replace('"published"', '"draft"')]) {
    const manifest = structuredClone(f.expected.manifest); manifest.data.materials[0].sha256 = sha256(text);
    const receipt = { ...f.receipt, collection_snapshots: publication_inventory(manifest.data, f.receipt.collections)
      .map(item => ({ ...item, root: f.expected.collections.get(item.collection) })) };
    assert.throws(() => verify_publication_material(receipt, manifest, { ...read, text }), /identity or status/);
  }
});

test("delivery uses stable ids while Git source paths retain spaces and Unicode", () => {
  const f = fixture();
  f.expected.manifest.data.materials[0].path = "Архитектура/design notes.md";
  f.expected.manifest.sha256 = sha256(JSON.stringify(f.expected.manifest.data));
  f.receipt.manifest_sha256 = f.expected.manifest.sha256;
  f.receipt.collection_snapshots = publication_inventory(f.expected.manifest.data, f.receipt.collections)
    .map(item => ({ ...item, root: f.expected.collections.get(item.collection) }));
  match_publication_receipt(f.receipt, f.expected, now);
  assert.equal(verify_publication_material(f.receipt, f.expected.manifest, { uri: f.uri, collection: "architecture", text: f.text }).path,
    "Архитектура/design notes.md");
});

test("only an operator-signed publisher confirmation authenticates the exact snapshot", t => {
  const f = fixture(); trust(t, [signed(f.receipt)]);
  const confirmation = new PublicationConfirmation(f.expected, now);
  assert.equal(confirmation.check(now).index_revision, "index-1");
  assert.equal(confirmation.material({ uri: f.uri, collection: "architecture", text: f.text }, now).id, "design");
  for (const envelopes of [[{ payload: f.receipt, ready: true }], [{ ...signed(f.receipt), signature: "forged" }],
    [signed({ ...f.receipt, index_revision: "index-2" }), signed(f.receipt)],
    [signed({ ...f.receipt, manifest_sha256: "f".repeat(64) })], [signed({ ...f.receipt, expires_at: "2026-10-26T07:30:00Z" })],
    [{ ready: true }], []]) {
    process.env.EDT_AI_OPENVIKING_PUBLICATION_RECEIPTS = JSON.stringify(envelopes);
    assert.throws(() => new PublicationConfirmation(f.expected, now));
  }
});

test("confirmation reuse is bounded by time and operator state, with no corpus rescan", t => {
  const f = fixture(); trust(t, [signed(f.receipt)]);
  const revision = publication_revision({ url: f.expected.endpoint });
  const confirmation = new PublicationConfirmation(f.expected, now);
  // Caller-owned objects, including returned evidence, cannot mutate the pin.
  f.expected.manifest.data.materials = []; f.receipt.index_revision = "caller-mutated";
  const copy = confirmation.check(now); copy.index_revision = "returned-mutated";
  confirmation.entry(f.uri, "architecture", now).sha256 = "returned-mutated";
  for (let index = 0; index < 20; index++) {
    assert.equal(confirmation.check(now).index_revision, "index-1");
    assert.equal(confirmation.entry(f.uri, "architecture", now).id, "design");
  }
  assert.throws(() => confirmation.check(Date.parse("2026-10-26T09:00:00Z")), /current/);
  process.env.EDT_AI_OPENVIKING_PUBLICATION_PUBLIC_KEY = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.notEqual(publication_revision({ url: f.expected.endpoint }), revision);
  assert.throws(() => confirmation.check(now), /trust key changed/);
  assert.throws(() => new PublicationConfirmation(f.expected, now), /signed publication/);
});

test("a staged future confirmation invalidates reuse when it becomes active", t => {
  const f = fixture(), next = { ...f.receipt, index_revision: "index-2", verified_at: "2026-10-26T08:30:00Z" };
  trust(t, [signed(f.receipt), signed(next)]);
  const confirmation = new PublicationConfirmation(f.expected, now);
  assert.equal(confirmation.check(now).index_revision, "index-1");
  const activated = Date.parse(next.verified_at);
  assert.throws(() => confirmation.check(activated), /became active/);
  assert.throws(() => new PublicationConfirmation(f.expected, activated), /Conflicting/);
});

test("conflicting snapshots for shared roots cannot hide behind another manifest or selected subset", t => {
  const f = fixture(); trust(t, [signed(f.receipt)]);
  const subset = { ...f.receipt, collections: ["architecture"], collection_snapshots: f.receipt.collection_snapshots.slice(0, 1) };
  process.env.EDT_AI_OPENVIKING_PUBLICATION_RECEIPTS = JSON.stringify([signed(f.receipt), signed(subset)]);
  assert.equal(new PublicationConfirmation(f.expected, now).check(now).index_revision, "index-1");
  process.env.EDT_AI_OPENVIKING_PUBLICATION_RECEIPTS = JSON.stringify([signed(f.receipt), signed({ ...f.receipt,
    verified_at: "2026-10-26T07:30:00Z", evidence_ref: "https://example.org/publication/renewed" })]);
  assert.equal(new PublicationConfirmation(f.expected, now).check(now).index_revision, "index-1");
  for (const patch of [{ manifest_sha256: "f".repeat(64) }, { index_revision: "index-2" }, { publication_revision: "f".repeat(40) },
    { collection_snapshots: subset.collection_snapshots.map(item => ({ ...item, materials_sha256: "f".repeat(64) })) }]) {
    process.env.EDT_AI_OPENVIKING_PUBLICATION_RECEIPTS = JSON.stringify([signed(f.receipt), signed({ ...subset, ...patch })]);
    assert.throws(() => new PublicationConfirmation(f.expected, now), /Conflicting/);
  }
  const future = { ...subset, manifest_sha256: "f".repeat(64), verified_at: "2026-10-26T08:30:00Z" };
  process.env.EDT_AI_OPENVIKING_PUBLICATION_RECEIPTS = JSON.stringify([signed(f.receipt), signed(future)]);
  const confirmation = new PublicationConfirmation(f.expected, now);
  assert.throws(() => confirmation.check(Date.parse(future.verified_at)), /became active/);
});
