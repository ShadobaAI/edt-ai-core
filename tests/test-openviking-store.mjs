import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { fixture, environment, session } from "./helpers.mjs";
import { stable, check_schema, settings } from "../scripts/common.mjs";
import { read_openviking_record, save_openviking_record } from "../scripts/openviking_store.mjs";
import { credential_binding, search_credential_headers, verify_search_access, surface_fingerprint, operation_fingerprint } from "../scripts/openviking_access.mjs";
import { binding_fingerprint } from "../scripts/components.mjs";
import { OpenVikingAdapter } from "../scripts/openviking_adapter.mjs";

const url = "https://knowledge.example/mcp", other = "https://other.example/mcp";
const values = () => ({ credential: "Bearer secret-token", bindingKey: "binding-key-at-least-32-bytes-long", accessPublicKey: "", accessReceipts: "", publicationPublicKey: "", publicationReceipts: "" });
const save = (state, endpoint, id, value, revision) => save_openviking_record(endpoint, id, value, revision, state);

test("shared records use exact URL and optional connection id without fallback", async t => {
  const f = fixture(t); environment(t, f.env);
  const a = read_openviking_record(url, undefined, f.state);
  assert.deepEqual(a, read_openviking_record(url, "", f.state));
  const written = await save(f.state, url, "", values(), a.revision);
  assert.equal(read_openviking_record(url, "", f.state).values.credential, "Bearer secret-token");
  assert.equal(read_openviking_record(url, "named", f.state).revision, "missing");
  assert.equal(read_openviking_record(other, "", f.state).revision, "missing");
  await save(f.state, other, "named", { ...values(), credential: "other" }, "missing");
  await save(f.state, url, "named", { ...values(), credential: "named" }, "missing");
  assert.equal(read_openviking_record(other, "named", f.state).values.credential, "other");
  assert.equal(read_openviking_record(url, "named", f.state).values.credential, "named");
  assert.notEqual(written.revision, "missing");
  for (const id of [" ", "../x", "x/y", "x".repeat(65), "ю"]) assert.throws(() => read_openviking_record(url, id, f.state));
  if (process.platform !== "win32") {
    const dir = path.join(f.state, "openviking-private");
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  }
});

test("concurrent processes cannot silently overwrite an editor's revision", async t => {
  const f = fixture(t); environment(t, f.env);
  const revision = (await save(f.state, url, "", values(), "missing")).revision;
  const script = `import {save_openviking_record} from './scripts/openviking_store.mjs'; const [state,url,revision,value]=process.argv.slice(1); try { await save_openviking_record(url,'',{credential:value,bindingKey:'',accessPublicKey:'',accessReceipts:'',publicationPublicKey:'',publicationReceipts:''},revision,state); process.exitCode=0; } catch { process.exitCode=7; }`;
  const run = value => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, f.state, url, revision, value], { cwd: process.cwd(), windowsHide: true, stdio: "ignore" });
    child.once("error", reject); child.once("exit", resolve);
  });
  assert.deepEqual((await Promise.all([run("first"), run("second")])).sort(), [0, 7]);
  assert.ok(["first", "second"].includes(read_openviking_record(url, "", f.state).values.credential));
});

test("signed access is tied to the current stored credential, key and selected area", async t => {
  const f = fixture(t); environment(t, f.env);
  const keys = generateKeyPairSync("ed25519"), options = { url, connection_id: "team" };
  let data = { ...values(), accessPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }) };
  let rev = (await save(f.state, url, "team", data, "missing")).revision;
  const op = name => ({ name, purpose: name === "find" ? "scoped_search" : "scoped_read", descriptor_sha256: "a".repeat(64), side_effects: "none", scope_enforced: true, evidence_ref: "fixture" });
  const payload = { schema_version: "0.1", endpoint: url, principal: "fixture", purpose: "search_readonly", credential_binding: credential_binding(options),
    permissions: { search: true, read: true, write: false, delete: false, publish: false, acl: false, session_capture: false, personal_areas: false },
    team_roots: ["viking://resources/team"], tools_sha256: "a".repeat(64), operations: { search: op("find"), read: op("read") },
    verification: { verifier: "fixture", deployment_id: "one", policy_revision: "one", negative_test_scope: { kind: "isolated", reference: "fixture" },
      bypass: Object.fromEntries(["rest", "cli", "publication_credentials", "direct_endpoint"].map(name => [name, { status: "confirmed", target: "fixture", restriction: name === "publication_credentials" ? "unavailable" : "same_readonly_acl", evidence_ref: "fixture" }])),
      checks: Object.fromEntries(["team_read", "search_credentials_only", "write_denied", "delete_denied", "publish_denied", "acl_denied", "session_capture_denied", "personal_areas_denied"].map(name => [name, { status: "confirmed", evidence_ref: "fixture" }])) },
    verified_at: new Date(Date.now() - 60000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() };
  check_schema(payload, "knowledge-access-receipt.schema.json");
  data = { ...data, accessReceipts: JSON.stringify([{ payload, signature: sign(null, Buffer.from(stable(payload)), keys.privateKey).toString("base64") }]) };
  rev = (await save(f.state, url, "team", data, rev)).revision;
  const allowed = new Map([["one", "viking://resources/team/one"]]);
  assert.equal(verify_search_access(options, allowed).principal, "fixture");
  assert.throws(() => verify_search_access(options, new Map([["other", "viking://resources/other"]])));
  assert.deepEqual(search_credential_headers(options), { authorization: "Bearer secret-token" });
  for (const name of ["OPENVIKING_SEARCH_TOKEN", "EDT_AI_OPENVIKING_URL", "EDT_AI_OPENVIKING_ACCESS_BINDING_KEY",
    "EDT_AI_OPENVIKING_ACCESS_PUBLIC_KEY", "EDT_AI_OPENVIKING_ACCESS_RECEIPTS",
    "EDT_AI_OPENVIKING_PUBLICATION_PUBLIC_KEY", "EDT_AI_OPENVIKING_PUBLICATION_RECEIPTS"]) process.env[name] = "ignored-fixture-value";
  assert.equal(verify_search_access(options, allowed).principal, "fixture");
  process.env.EDT_AI_STATE_DIR = path.join(f.base, "another-state");
  assert.throws(() => verify_search_access(options, allowed));
  assert.equal(verify_search_access(options, allowed, Date.now(), f.state).principal, "fixture");
  process.env.EDT_AI_STATE_DIR = f.state;
  const profile = f.profile, config = settings(f.env.EDT_AI_SETTINGS); config.mcp.optional.openviking = { ...config.mcp.optional.openviking, ...options };
  const fingerprint = binding_fingerprint(config, "openviking", f.root, profile);
  rev = (await save(f.state, url, "team", { ...data, credential: "Bearer changed" }, rev)).revision;
  assert.notEqual(binding_fingerprint(config, "openviking", f.root, profile), fingerprint);
  assert.throws(() => verify_search_access(options, allowed));
  rev = (await save(f.state, url, "team", { ...data, bindingKey: "another-binding-key-at-least-32-bytes" }, rev)).revision;
  assert.throws(() => verify_search_access(options, allowed));
  await save(f.state, url, "team", { ...data, accessPublicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) }, rev);
  assert.throws(() => verify_search_access(options, allowed));
});

test("secret values use app metadata only and are absent from export", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  const client = await session(t, "mcp/settings.mjs", [], f);
  const input = values(), args = { url, connectionId: "team" };
  const initial = await client.call("settings.openviking_read", args);
  assert.equal(initial._meta.data.revision, "missing");
  const saved = await client.call("settings.openviking_save", { ...args, values: input, expectedRevision: "missing" });
  assert.ok(saved._meta.data.revision);
  const reopened = await client.call("settings.openviking_read", args);
  assert.deepEqual(reopened._meta.data.values, input);
  assert.equal(JSON.stringify(reopened.content).includes(input.credential), false);
  for (const name of ["settings.read", "settings.inspect", "settings.export_data", "settings.diagnostics"]) {
    const reply = await client.call(name, {});
    assert.equal(JSON.stringify(reply).includes(input.credential), false, name);
    assert.equal(JSON.stringify(reply).includes(input.bindingKey), false, name);
  }
});

test("independent project adapters share a credential but never share selected areas or connections", async t => {
  const f = fixture(t); environment(t, f.env); const keys = generateKeyPairSync("ed25519");
  const options = { enabled: true, url, connection_id: "team", timeout_seconds: 10, max_response_bytes: 4096 };
  let data = { ...values(), accessPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }) };
  let revision = (await save(f.state, url, "team", data, "missing")).revision;
  const tools = [
    { name: "find", inputSchema: { type: "object", properties: { query: { type: "string" }, target_uri: { type: "string" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false }, outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } },
    { name: "read", inputSchema: { type: "object", properties: { uris: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["uris"], additionalProperties: false } },
  ];
  const operation = (name, purpose) => ({ name, purpose, descriptor_sha256: operation_fingerprint(tools.find(item => item.name === name)), side_effects: "none", scope_enforced: true, evidence_ref: "fixture" });
  const payload = { schema_version: "0.1", endpoint: url, principal: "fixture", purpose: "search_readonly", credential_binding: credential_binding(options), team_roots: ["viking://resources/team"],
    permissions: { search: true, read: true, write: false, delete: false, publish: false, acl: false, session_capture: false, personal_areas: false },
    tools_sha256: surface_fingerprint(tools), operations: { search: operation("find", "scoped_search"), read: operation("read", "scoped_read") },
    verification: { verifier: "fixture", deployment_id: "one", policy_revision: "one", negative_test_scope: { kind: "isolated", reference: "fixture" },
      bypass: Object.fromEntries(["rest", "cli", "publication_credentials", "direct_endpoint"].map(name => [name, { status: "confirmed", target: "fixture", restriction: name === "publication_credentials" ? "unavailable" : "same_readonly_acl", evidence_ref: "fixture" }])),
      checks: Object.fromEntries(["team_read", "search_credentials_only", "write_denied", "delete_denied", "publish_denied", "acl_denied", "session_capture_denied", "personal_areas_denied"].map(name => [name, { status: "confirmed", evidence_ref: "fixture" }])) },
    verified_at: new Date(Date.now() - 60000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() };
  data = { ...data, accessReceipts: JSON.stringify([{ payload, signature: sign(null, Buffer.from(stable(payload)), keys.privateKey).toString("base64") }]) };
  revision = (await save(f.state, url, "team", data, revision)).revision;
  const makeProfile = name => ({ ...f.profile, knowledge: { provider: "openviking", mode: "transitional", manifest: null, collections: [name], required: false,
    dependent_actions: [], collection_uris: { [name]: "viking://resources/team/" + name } } });
  const config = settings(f.env.EDT_AI_SETTINGS); config.mcp.optional.openviking = options;
  const makeClient = () => ({ tools_revision: 0, initialization: { capabilities: { tools: {} } }, async initialize() {}, async close() {},
    async request(method) { if (method === "tools/list") return { tools }; throw new Error("Unexpected native request"); } });
  const first = new OpenVikingAdapter(makeProfile("one"), config, makeClient(), null, f.root, f.state);
  const second = new OpenVikingAdapter(makeProfile("two"), config, makeClient(), null, f.root, f.state);
  t.after(async () => { await first.close(); await second.close(); });
  await first.connect(); await second.connect();
  assert.notEqual(first.client, second.client);
  assert.deepEqual([...first.collections.keys()], ["one"]); assert.deepEqual([...second.collections.keys()], ["two"]);
  assert.throws(() => first.validateRequest("tools/call", { name: "find", arguments: { query: "x", target_uri: "viking://resources/team/two", limit: 1 } }), /selected|collection|scope/i);
  await save(f.state, url, "team", { ...data, publicationPublicKey: "changed" }, revision);
  assert.throws(() => first.checkAccess(), /changed/); assert.throws(() => second.checkAccess(), /changed/);
});
