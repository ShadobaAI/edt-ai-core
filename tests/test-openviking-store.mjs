import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { fixture, environment, session, ROOT } from "./helpers.mjs";
import { stable, check_schema, settings } from "../scripts/common.mjs";
import { read_openviking_record, save_openviking_record } from "../scripts/openviking_store.mjs";
import { credential_binding, search_credential_headers, verify_search_access, surface_fingerprint, operation_fingerprint } from "../scripts/openviking_access.mjs";
import { binding_fingerprint } from "../scripts/components.mjs";
import { OpenVikingAdapter } from "../scripts/openviking_adapter.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";

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

test("Windows record and directory ACL grant access only to the owner", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t); await save(f.state, url, "", values(), "missing");
  const k = createRequire(import.meta.url)(path.join(ROOT, "vendor/native", `win32_${process.arch}`, "koffi.node"));
  const adv = k.load("advapi32.dll"), kernel = k.load("kernel32.dll");
  const open = adv.func("int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)");
  const info = adv.func("int __stdcall GetTokenInformation(void *token, int kind, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *needed)");
  const get = adv.func("uint32_t __stdcall GetNamedSecurityInfoW(str16 file, int type, uint32_t info, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)");
  const aclInfo = adv.func("int __stdcall GetAclInformation(void *acl, _Out_ void *information, uint32_t size, int kind)");
  const aceAt = adv.func("int __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)");
  const equal = adv.func("int __stdcall EqualSid(void *left, void *right)");
  const current = kernel.func("void * __stdcall GetCurrentProcess()"), close = kernel.func("int __stdcall CloseHandle(void *handle)"), free = kernel.func("void * __stdcall LocalFree(void *pointer)");
  const token = [null], userBuffer = Buffer.alloc(4096), needed = [0];
  assert.ok(open(current(), 8, token));
  try {
    assert.ok(info(token[0], 1, userBuffer, userBuffer.length, needed));
    const user = k.decode(userBuffer, "void *"), directory = path.join(f.state, "openviking-private");
    const file = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith(".json")));
    for (const [target, directoryExpected] of [[directory, true], [file, false]]) {
      const owner = [null], dacl = [null], descriptor = [null];
      assert.equal(get(target, 1, 5, owner, null, dacl, null, descriptor), 0);
      try {
        assert.ok(equal(owner[0], user));
        const information = Buffer.alloc(12); assert.ok(aclInfo(dacl[0], information, information.length, 2));
        assert.equal(information.readUInt32LE(0), 1, "DACL must contain exactly one ACE");
        const ace = [null]; assert.ok(aceAt(dacl[0], 0, ace));
        const header = Buffer.from(k.decode(ace[0], "uint8_t", 4));
        const bytes = Buffer.from(k.decode(ace[0], "uint8_t", header.readUInt16LE(2)));
        assert.equal(bytes[0], 0, "ACE must allow access");
        assert.equal(bytes[1] & 3, directoryExpected ? 3 : 0, "inheritance must match the object type");
        assert.ok(equal(bytes.subarray(8), user), "ACE must grant access to the token user");
      } finally { if (descriptor[0]) free(descriptor[0]); }
    }
  } finally { close(token[0]); }
});

test("Windows creates private records for the user even with an administrator default owner", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t), storeModule = pathToFileURL(path.join(ROOT, "scripts/openviking_store.mjs")).href;
  const nativeModule = path.join(ROOT, "vendor/native", `win32_${process.arch}`, "koffi.node");
  // Change only this child process token; a normal non-elevated token cannot
  // choose Administrators as its owner. CI's elevated token exercises it.
  const script = `import fs from 'node:fs'; import path from 'node:path'; import {createRequire} from 'node:module';
    import {read_openviking_record,save_openviking_record} from ${JSON.stringify(storeModule)};
    const k=createRequire(import.meta.url)(${JSON.stringify(nativeModule)}), a=k.load('advapi32.dll'), kernel=k.load('kernel32.dll');
    const ownerStruct=k.struct({Owner:'void *'});
    const open=a.func('int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)');
    const tokenInfo=a.func('int __stdcall GetTokenInformation(void *token, int kind, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *needed)');
    const setToken=a.func('__stdcall','SetTokenInformation','int',['void *','int',k.pointer(ownerStruct),'uint32_t']);
    const parseSid=a.func('int __stdcall ConvertStringSidToSidW(str16 text, _Out_ void **sid)');
    const equal=a.func('int __stdcall EqualSid(void *left, void *right)');
    const getSecurity=a.func('uint32_t __stdcall GetNamedSecurityInfoW(str16 file, int type, uint32_t info, _Out_ void **owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)');
    const current=kernel.func('void * __stdcall GetCurrentProcess()'), close=kernel.func('int __stdcall CloseHandle(void *handle)'), free=kernel.func('void * __stdcall LocalFree(void *pointer)');
    const token=[null],admins=[null]; if(!open(current(),0x88,token)||!parseSid('S-1-5-32-544',admins)) throw Error('token setup failed');
    const needed=[0], userBuffer=Buffer.alloc(4096); if(!tokenInfo(token[0],1,userBuffer,userBuffer.length,needed)) throw Error('token user unavailable');
    const user=k.decode(userBuffer,'void *');
    if(!setToken(token[0],4,{Owner:admins[0]},k.sizeof(ownerStruct))) { close(token[0]); free(admins[0]); console.log('not-applicable'); process.exit(0); }
    const ownerIs=(file,sid)=>{const owner=[null],descriptor=[null];const status=getSecurity(file,1,1,owner,null,null,null,descriptor);try{return status===0&&Boolean(equal(owner[0],sid));}finally{if(descriptor[0])free(descriptor[0]);}};
    const state=process.argv[1],foreign=path.join(state,'foreign','openviking-private'); fs.mkdirSync(foreign,{recursive:true});
    if(!ownerIs(foreign,admins[0])) throw Error('fixture did not receive administrator default owner');
    const payload={credential:'fixture',bindingKey:'',accessPublicKey:'',accessReceipts:'',publicationPublicKey:'',publicationReceipts:''};
    let rejected=false;try{await save_openviking_record('https://fixture.example/mcp','',payload,'missing',path.dirname(foreign));}catch(e){rejected=/принадлежит другому пользователю/.test(e.message);}if(!rejected)throw Error('foreign-owned directory was accepted');
    const own=path.join(state,'own'); await save_openviking_record('https://fixture.example/mcp','',payload,'missing',own);
    const directory=path.join(own,'openviking-private'),name=fs.readdirSync(directory).find(n=>n.endsWith('.json'));
    if(!name||!ownerIs(directory,user)||!ownerIs(path.join(directory,name),user))throw Error('private objects are not owned by the token user');
    if(read_openviking_record('https://fixture.example/mcp','',own).values.credential!=='fixture')throw Error('record did not round-trip');
    close(token[0]);free(admins[0]);console.log('verified');`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.state], { encoding: "utf8", windowsHide: true, shell: false, timeout: 20000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  if (result.stdout.trim() === "not-applicable") { t.skip("Current token cannot select Administrators as default owner"); return; }
  assert.equal(result.stdout.trim(), "verified");
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
  for (const name of ["settings.read", "settings.inspect", "settings.diagnostics"]) {
    const reply = await client.call(name, {});
    assert.equal(JSON.stringify(reply).includes(input.credential), false, name);
    assert.equal(JSON.stringify(reply).includes(input.bindingKey), false, name);
  }
  const exported = await new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS).main({action:"transfer_export", scope:"profile", projectRoot:f.root});
  assert.equal(JSON.stringify(exported).includes(input.credential), false);
  assert.equal(JSON.stringify(exported).includes(input.bindingKey), false);
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
