import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { loadProfile, checkFiles, startArguments, platformCommandLine, clientAdditionalParameters, configSnippet, digest, interactiveParameters } from "../vanessa/profile.mjs";
import { listTools, checkArguments, redact } from "../vanessa/mcp.mjs";
import { main, doctor } from "../vanessa/vanessa.mjs";
import { withProfileLock, checkOwner, checkClaims, clientControlKey, registryDir } from "../vanessa/runtime.mjs";
import { requiredTools, inspectSession, connectSession, setupSession, taxiCompatible, isLocalComputer } from "../vanessa/readiness.mjs";
import { ownRecording, recordOwnership, invalidateObservedIdle } from "../vanessa/recording.mjs";
import { parseEnvironment, parseState, parseProfiles, parseEditor, parseInfobase, parseExtensions, parseProcesses, parseClientLaunch, parseSyntax, parseSelection, editorContent, normalizeFeatureText } from "../vanessa/runtime-contract.mjs";
import * as wire from "./test-vanessa-ui-fixtures.mjs";
import { runFeature } from "../vanessa/run.mjs";
import { awaitEditorTransition } from "../vanessa/transition.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-ui-contract-"));
// Isolate the shared control registry from real manager claims on this machine.
// Only this fixture process sees the replacement; no user metadata is removed.
const nativeTmpdir = os.tmpdir;
os.tmpdir = () => path.join(root, "isolated-system-temp");
fs.mkdirSync(os.tmpdir());
const profileFile = path.join(root, "config", "ui.json");
fs.mkdirSync(path.dirname(profileFile)); fs.mkdirSync(path.join(root, "features")); fs.mkdirSync(path.join(root, "base"));
fs.writeFileSync(path.join(root, "platform.exe"), "fixture"); fs.writeFileSync(path.join(root, "runtime.epf"), "fixture");
let calls = [], mode = "normal", networkTools, networkCall;
const server = createServer(async (req, res) => {
  if (req.method === "DELETE") return res.writeHead(204).end();
  let body = ""; for await (const chunk of req) body += chunk;
  const msg = JSON.parse(body); calls.push(msg);
  if (msg.method === "notifications/initialized") return res.writeHead(202).end();
  let result;
  if (msg.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "vanessa-fixture", version: "1" }, capabilities: { tools: {} } };
  if (msg.method === "tools/list") result = msg.params.cursor ? { tools: [{ name: "mutate", inputSchema: { type: "object", properties: { selected: { type: "string" } }, required: ["selected"], additionalProperties: false } }] }
    : { tools: requiredTools.map(name => ({ name, inputSchema: name === "manage_test_client_profiles" ? { type: "object", properties: { action: { type: "string", enum: ["get_list"] } }, required: ["action"], additionalProperties: false } : name === "get_editor_state" ? { type: "object", properties: { includeContent: { type: "boolean" } }, additionalProperties: false } : { type: "object", additionalProperties: false } })), nextCursor: "page2" };
  if (msg.method === "tools/call") {
    if (networkCall) {
      result = networkCall(msg.params.name, msg.params.arguments);
      if (result === undefined) return;
    } else {
      if (mode === "timeout") return;
      result = mode === "tool-error" ? { isError: true, content: [{ type: "text", text: "Password=fixture-secret" }] } : { content: [{ type: "text", text: "unrecognized runtime response" }] };
    }
  }
  if (msg.method === "tools/list" && networkTools) result = { tools: networkTools };
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const raw = {
  version: 1, id: "arbitrary-project", projectRoot: "..", platform: "../platform.exe", runtime: { epf: "../runtime.epf" },
  manager: { infobase: { type: "file", path: "../base" } }, client: { name: "fixture-" + path.basename(root), infobase: { type: "file", path: "../base" } },
  mcp: { url: `http://127.0.0.1:${port}/mcp`, port }, features: "../features", results: "../results", limits: { timeoutMs: 1000 },
};
const write = value => fs.writeFileSync(profileFile, JSON.stringify(value));
try {
  write(raw);
  const profile = loadProfile(profileFile);
  const authorizedArgsFile = path.join(root, "arguments.json");
  fs.writeFileSync(authorizedArgsFile, "{}");
  const authorizedArgsHash = digest(fs.readFileSync(authorizedArgsFile));
  fs.writeFileSync(authorizedArgsFile, '{"changed":true}');
  const callsBeforeMismatch = calls.filter(call => call.method === "tools/call").length;
  await assert.rejects(main(["call", "--profile", profileFile, "--tool", "get_test_results", "--arguments-file", authorizedArgsFile,
    "--expected-arguments-sha256", authorizedArgsHash]), /arguments changed after authorization/);
  assert.equal(calls.filter(call => call.method === "tools/call").length, callsBeforeMismatch);
  const authorizedHash = digest(fs.readFileSync(profileFile));
  assert.equal(loadProfile(profileFile, authorizedHash).id, raw.id);
  write({ ...raw, client: { ...raw.client, name: "changed-after-consent" } });
  await assert.rejects(main(["configure", "--profile", profileFile, "--expected-profile-sha256", authorizedHash]), /changed after authorization/);
  write(raw);
  assert.equal(profile.projectRoot, root); assert.equal(profile.mcp.serverName, "vanessa"); checkFiles(profile);
  assert.equal(startArguments(profile).includes("/TESTMANAGER"), true);
  assert.equal(startArguments(profile).includes("/iTaxi"), true);
  assert.equal(profile.manager.interface, "taxi"); assert.equal(profile.client.interface, "taxi");
  for (const host of ["localhost", "127.0.0.1", "::1", os.hostname()]) assert.equal(isLocalComputer(host), true);
  assert.equal(isLocalComputer("remote-test-host.invalid"), false);
  assert.equal(clientAdditionalParameters({ ...profile, client: { ...profile.client, userEnv: "UI_FIXTURE_USER" } }, { UI_FIXTURE_USER: "FixtureUser" }), '/iTaxi /N"FixtureUser"');
  assert.throws(() => clientAdditionalParameters({ ...profile, client: { ...profile.client, userEnv: "UI_FIXTURE_USER" } }, {}), /environment value/);
  assert.equal(taxiCompatible("/iTaxi"), true); assert.equal(taxiCompatible("/N fixture /ITAXI"), true);
  assert.equal(taxiCompatible("/iTaxi /itdi"), false); assert.equal(taxiCompatible("/itdi"), false);
  assert.equal(taxiCompatible(""), false); assert.equal(taxiCompatible(undefined), false);
  assert.equal(startArguments(profile).some(arg => /StartFeaturePlayer|all/.test(arg)), false);
  assert.match(startArguments(profile).at(-1), /UseEditor/);
  assert.equal(interactiveParameters(profile)["КаталогФич"], profile.features);
  assert.equal(interactiveParameters(profile)["ВыполнитьСценарии"], false);
  assert.equal(platformCommandLine(["/IBConnectionString", 'Srvr="localhost";Ref="example";']), '/IBConnectionString "Srvr=""localhost"";Ref=""example"";"');
  assert.equal(startArguments(profile).includes("/Out"), true);
  const firstLaunchArgs = startArguments(profile), secondLaunchArgs = startArguments(profile);
  const firstLog = firstLaunchArgs[firstLaunchArgs.indexOf("/Out") + 1], secondLog = secondLaunchArgs[secondLaunchArgs.indexOf("/Out") + 1];
  assert.notEqual(firstLog, secondLog, "each launch gets an independent log even while an old log remains locked");
  assert.equal(path.dirname(firstLog), profile.stateDir); assert.equal(path.dirname(secondLog), profile.stateDir);
  assert.match(path.basename(firstLog), /^startup-[a-f0-9-]+\.log$/);
  assert.equal(fs.existsSync(firstLog), false, "building arguments never deletes or creates log files");
  assert.match(configSnippet(profile), /\[mcp_servers.vanessa\]/);
  const secondFile = path.join(root, "config", "second.json"); fs.writeFileSync(secondFile, JSON.stringify(raw));
  assert.notEqual(profile.stateDir, loadProfile(secondFile).stateDir);
  const originalCwd = process.cwd(); process.chdir(os.tmpdir());
  try { assert.equal(loadProfile(profileFile).features, path.join(root, "features")); } finally { process.chdir(originalCwd); }
  for (const broken of [
    { ...raw, password: "secret" }, { ...raw, version: 2 }, { ...raw, mcp: { ...raw.mcp, port: port + 1 } },
    { ...raw, mcp: { ...raw.mcp, url: `http://user:secret@127.0.0.1:${port}/mcp` } },
    { ...raw, mcp: { ...raw.mcp, url: `http://192.0.2.1:${port}/mcp` } },
    { ...raw, manager: { infobase: { type: "file", path: "../base", server: "host" } } },
    { ...raw, limits: { maxBytes: 99999999 } },
    { ...raw, manager: { ...raw.manager, interface: "tabs" } },
    { ...raw, client: { ...raw.client, interface: "itdi" } },
  ]) { write(broken); assert.throws(() => loadProfile(profileFile)); }
  write(raw);
  write({ ...raw, runtime: { navigationUrl: "e1cib/app/Обработка.TestRuntime" }, manager: { ...raw.manager, userEnv: "VANESSA_UI_FIXTURE_USER" } });
  const embedded = loadProfile(profileFile); checkFiles(embedded);
  assert.equal(startArguments(embedded, { VANESSA_UI_FIXTURE_USER: "fixture-user" }).includes("/URL"), true);
  assert.equal(startArguments(embedded, { VANESSA_UI_FIXTURE_USER: "fixture-user" }).includes("/Execute"), false);
  assert.equal(startArguments(embedded, { VANESSA_UI_FIXTURE_USER: "fixture-user" }).includes("fixture-user"), true);
  assert.throws(() => startArguments(embedded, {}), /environment value/);
  assert.ok(!JSON.stringify(embedded).includes("fixture-user"));
  write(raw);
  const paramsFile = path.join(root, "config", "params.json");
  fs.writeFileSync(paramsFile, JSON.stringify({ "ВыполнитьСценарии": true }));
  write({ ...raw, runtime: { ...raw.runtime, paramsFile: "params.json" } });
  assert.throws(() => checkFiles(loadProfile(profileFile)), /interactive/);
  fs.writeFileSync(paramsFile, JSON.stringify({ "ВыполнитьСценарии": false, "ЗавершитьРаботуСистемы": false, "ИспользоватьКомпонентуVanessaExt": true }));
  checkFiles(loadProfile(profileFile));
  fs.writeFileSync(paramsFile, JSON.stringify({ password: "must-not-persist" }));
  assert.throws(() => interactiveParameters(loadProfile(profileFile)), /credentials/);
  fs.writeFileSync(paramsFile, JSON.stringify({ StartFeaturePlayer: true }));
  assert.throws(() => interactiveParameters(loadProfile(profileFile)), /forbidden execution/);
  const manifestFile = path.join(root, "manifest.json");
  const manifest = { version: 1, product: "fixture", release: "1", source: { url: "https://example.invalid/runtime.zip", sha256: "a".repeat(64) }, files: [{ path: "runtime.epf", sha256: digest("fixture") }] };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  write({ ...raw, runtime: { ...raw.runtime, manifest: "../manifest.json" } });
  checkFiles(loadProfile(profileFile));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, files: [{ path: "runtime.epf", sha256: "a".repeat(64) }] }));
  assert.throws(() => checkFiles(loadProfile(profileFile)), /integrity/);
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, files: [{ path: "../runtime.epf", sha256: "a".repeat(64) }] }));
  assert.throws(() => checkFiles(loadProfile(profileFile)), /escapes/);
  write(raw);

  await withProfileLock(profile, async () => {
    const aliasedProfile = { ...profile, identity: "different-profile-identity", client: { ...profile.client, name: "OtherAlias" }, mcp: { ...profile.mcp, port: port + 1 } };
    assert.equal(clientControlKey(aliasedProfile), clientControlKey(profile));
    await assert.rejects(withProfileLock(aliasedProfile, async () => assert.fail("client aliases must share base control lock")), /another UI control/);
    const changedSettings = { ...profile, client: { ...profile.client, name: "different-client" }, mcp: { ...profile.mcp, port: port + 1 } };
    await assert.rejects(withProfileLock(changedSettings, async () => assert.fail("same profile path must serialize changed settings")), /another UI control/);
    await assert.rejects(withProfileLock(loadProfile(secondFile), async () => assert.fail("lock must isolate endpoint")), /another UI control/);
    const thirdFile = path.join(root, "config", "third.json");
    fs.writeFileSync(thirdFile, JSON.stringify({ ...raw, mcp: { url: `http://127.0.0.1:${port + 1}/mcp`, port: port + 1 } }));
    await assert.rejects(withProfileLock(loadProfile(thirdFile), async () => assert.fail("lock must isolate TestClient")), /another UI control/);
  });
  assert.equal(checkOwner(profile), null);
  const foreignOwnerFile = path.join(registryDir(), `endpoint-${port}.owner.json`);
  fs.writeFileSync(foreignOwnerFile, JSON.stringify({ profile: "other-profile", pid: process.pid, status: "running", client: clientControlKey(profile), clientKeyVersion: 2 }));
  try { assert.throws(() => checkClaims(profile), /TestClient belongs/); } finally { fs.unlinkSync(foreignOwnerFile); }
  fs.writeFileSync(foreignOwnerFile, JSON.stringify({ profile: "other" }));
  try { assert.throws(() => checkOwner(profile), /another profile/); } finally { fs.unlinkSync(foreignOwnerFile); }
  fs.writeFileSync(foreignOwnerFile, JSON.stringify({ profile: profile.identity, pid: process.pid, status: "running" }));
  try {
    const changedPort = { ...profile, mcp: { ...profile.mcp, port: port + 1 } };
    assert.throws(() => checkClaims(changedPort), /another endpoint/);
  } finally { fs.unlinkSync(foreignOwnerFile); }
  const exitedChild = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
  assert.equal(exitedChild.status, 0);
  fs.writeFileSync(foreignOwnerFile, JSON.stringify({ profile: profile.identity, pid: exitedChild.pid, status: "running", fingerprint: "previous-settings" }));
  try {
    assert.equal(checkOwner(profile).pid, exitedChild.pid, "dead own process permits new launch settings");
    fs.writeFileSync(foreignOwnerFile, JSON.stringify({ profile: profile.identity, pid: exitedChild.pid, status: "starting", fingerprint: "previous-settings" }));
    assert.throws(() => checkOwner(profile), /indeterminate/);
  } finally { fs.unlinkSync(foreignOwnerFile); }

  const listed = await main(["list", "--profile", profileFile]); assert.equal(listed.tools.length, requiredTools.length + 1);
  assert.equal(calls.some(call => call.method === "tools/list" && call.params.cursor === "page2"), true);
  assert.equal((await main(["configure", "--profile", profileFile])).status, "configuration_only");
  assert.equal((await doctor(profile)).status, "unverified");
  const result = await main(["call", "--profile", profileFile, "--tool", "get_environment_data"]);
  assert.equal(result.status, "completed");
  await assert.rejects(main(["call", "--profile", profileFile, "--tool", "mutate"]), /readiness is unverified/);
  assert.equal(calls.some(call => call.method === "tools/call" && call.params.name === "mutate"), false);
  mode = "tool-error";
  await assert.rejects(main(["call", "--profile", profileFile, "--tool", "get_environment_data"]), error => {
    assert.equal(error.code, "tool_error"); assert.equal(error.detail.outcome, "responded");
    assert.match(error.detail.result.content[0].text, /\[redacted\]/);
    return !JSON.stringify(error.detail).includes("fixture-secret");
  });
  mode = "timeout"; calls = [];
  await assert.rejects(main(["call", "--profile", profileFile, "--tool", "get_environment_data"]), /timed out/);
  assert.equal(calls.filter(call => call.method === "tools/call").length, 1);
  await assert.rejects(main(["list", "--profile", profileFile, "--bad", "x"]), /option/);
  await assert.rejects(listTools({ request: async () => ({ tools: [], nextCursor: "same" }) }), /cursor/);
  await assert.rejects(listTools({ request: async () => ({ tools: [{ name: "broken" }] }) }), /schema/);
  assert.throws(() => checkArguments({ required: ["selected"] }, {}), /missing/);
  assert.throws(() => checkArguments({ properties: { flag: { type: "boolean" } } }, { flag: "true" }), /type/);
  assert.throws(() => checkArguments({ additionalProperties: false }, { guessed: 1 }), /unknown/);
  assert.deepEqual(redact({ password: "private", nested: ["Pwd=private; Token=private"] }), { password: "[redacted]", nested: ["Pwd=[redacted]; Token=[redacted]"] });
  assert.equal(redact('/iTaxi /N"FixtureUser"'), "/iTaxi /N[redacted]");
  assert.deepEqual(redact({ inputSchema: { type: "object", properties: { password: { type: "string", default: "private" }, selected: { type: "string", enum: ["one", "two"] } } } }),
    { inputSchema: { type: "object", properties: { password: { type: "string", default: "[redacted]" }, selected: { type: "string", enum: ["one", "two"] } } } });

  // Semantic adapter fixtures exercise gating only, and are not wire-format evidence.
  let connected = false, mutationCount = 0, failureMode = "none";
  const fixtureTools = requiredTools.map(name => ({ name, inputSchema: { type: "object" } }));
  const fixtureClient = { request: async (method, params) => {
    if (params.name === "manage_test_client") {
      mutationCount++;
      assert.deepEqual(params.arguments, { action: "connect", profileName: profile.client.name });
      if (failureMode === "timeout") throw new Error("timeout");
      if (failureMode === "responded") return { isError: true, content: [{ type: "text", text: "cause: profile not available; Password=private" }] };
      connected = true;
    }
    return { content: [] };
  } };
  const semanticContract = {
    version: "semantic-fixture-only",
    environment: () => ({ managerInfobase: profile.manager.infobase, vanessaExt: true, runtimeVersion: "fixture" }),
    editor: () => ({ stateAvailable: true, errorCount: 0 }),
    profiles: () => [{ name: profile.client.name, infobase: profile.client.infobase, additionalParameters: "/iTaxi", computerName: profile.client.computerName, connected }],
    state: () => ({ connected, clientName: profile.client.name, clientInfobase: profile.client.infobase, running: false, recording: false }),
    extensions: () => [{ name: "VAExtension", active: true, version: "fixture" }],
    processes: () => ({ filter: "/TESTCLIENT", matchedCount: 1, processes: [{ pid: 12345, startedAt: "fixture-session", launch: { infobase: profile.client.infobase, interface: "taxi", testPort: 48000 } }] }),
  };
  const remoteProfile = { ...profile, client: { ...profile.client, computerName: "remote-test-host.invalid" } };
  const remoteResult = await inspectSession(remoteProfile, { request: () => assert.fail("remote client cannot reach mutation or discovery stages") }, fixtureTools, semanticContract);
  assert.equal(remoteResult.reason, "client_computer_is_not_verified_local", "sole local TestClient does not prove an unrelated remote connection");
  assert.equal((await connectSession(profile, fixtureClient, fixtureTools, semanticContract)).status, "ready");
  assert.equal(mutationCount, 1);
  const conflictingInterface = { ...semanticContract, profiles: () => [{ ...semanticContract.profiles()[0], additionalParameters: "/iTaxi /itdi" }] };
  assert.equal((await connectSession(profile, fixtureClient, fixtureTools, conflictingInterface)).reason, "client_interface_mismatch_or_unverified");
  assert.equal(mutationCount, 1, "conflicting TestClient interface is blocked before connect");
  assert.equal((await connectSession(profile, fixtureClient, fixtureTools, semanticContract)).status, "ready");
  assert.equal(mutationCount, 1);
  connected = false;
  const mismatch = { ...semanticContract, environment: () => ({ ...semanticContract.environment(), managerInfobase: { type: "file", path: root } }) };
  assert.equal((await connectSession(profile, fixtureClient, fixtureTools, mismatch)).reason, "manager_infobase_mismatch");
  assert.equal(mutationCount, 1);
  const recording = { ...semanticContract, state: () => ({ ...semanticContract.state(), recording: true }) };
  assert.equal((await connectSession(profile, fixtureClient, fixtureTools, recording)).reason, "session_busy_with_scenario_or_recording");
  const wrongProfiles = { ...semanticContract, profiles: () => [{ name: profile.client.name, infobase: { type: "file", path: root } }] };
  assert.equal((await connectSession(profile, fixtureClient, fixtureTools, wrongProfiles)).reason, "client_profile_mismatch_or_ambiguous");
  assert.equal(mutationCount, 1);
  failureMode = "responded";
  await assert.rejects(connectSession(profile, fixtureClient, fixtureTools, semanticContract), failure => failure.code === "tool_error" && failure.detail.outcome === "responded" && !JSON.stringify(failure.detail).includes("Password=private"));
  failureMode = "timeout";
  await assert.rejects(connectSession(profile, fixtureClient, fixtureTools, semanticContract), failure => failure.code === "mutation_indeterminate" && failure.detail.outcome === "indeterminate");
  assert.equal(mutationCount, 3, "neither response errors nor timeouts are retried");
  assert.equal((await inspectSession(profile, fixtureClient, fixtureTools)).status, "unverified");
  connected = false; failureMode = "none";
  let profilePresent = false, adds = 0;
  const setupContract = { ...semanticContract, profiles: () => profilePresent ? semanticContract.profiles() : [] };
  const setupClient = { request: async (method, params) => {
    if (params.name === "manage_test_client_profiles" && params.arguments.action === "add") {
      adds++; profilePresent = true;
      assert.equal(params.arguments.name, profile.client.name);
      assert.equal(params.arguments.infobase_path, `File="${profile.client.infobase.path}";`);
      assert.equal(params.arguments.additional_parameters, "/iTaxi");
      assert.equal(params.arguments.computer_name, "localhost");
      return { content: [] };
    }
    return fixtureClient.request(method, params);
  } };
  assert.equal((await setupSession(profile, setupClient, fixtureTools, setupContract)).status, "ready");
  assert.equal(adds, 1);
  assert.equal((await setupSession(profile, setupClient, fixtureTools, setupContract)).status, "ready");
  assert.equal(adds, 1, "setup never duplicates an existing exact profile");
  let computerFixed = false, edits = 0;
  const computerContract = { ...semanticContract, profiles: () => [{ ...semanticContract.profiles()[0], computerName: computerFixed ? "localhost" : "" }] };
  const editClient = { request: async (method, params) => {
    if (params.name === "manage_test_client_profiles" && params.arguments.action === "edit") {
      assert.deepEqual(params.arguments, { action: "edit", name: profile.client.name, computer_name: "localhost" });
      computerFixed = true; edits++; return { content: [] };
    }
    return fixtureClient.request(method, params);
  } };
  assert.equal((await setupSession(profile, editClient, fixtureTools, computerContract)).status, "ready");
  assert.equal(edits, 1);
  assert.equal((await setupSession(profile, editClient, fixtureTools, computerContract)).status, "ready");
  assert.equal(edits, 1, "computer-name repair neither reconnects nor repeats the edit");
  recordOwnership(profile, "active", "fixture-version", "manager-session-1");
  assert.equal(ownRecording(profile, "manager-session-1").status, "active");
  assert.throws(() => ownRecording(profile, "manager-session-2"), /manager session changed/);
  const ownRecordContract = { ...semanticContract, state: () => ({ ...semanticContract.state(), recording: true }) };
  assert.equal((await inspectSession(profile, fixtureClient, fixtureTools, ownRecordContract)).reason, "session_busy_with_scenario_or_recording");
  assert.equal((await inspectSession(profile, fixtureClient, fixtureTools, ownRecordContract, { ownRecording: true })).status, "ready");
  invalidateObservedIdle(profile, "fixture-version");
  assert.equal(ownRecording(profile, "manager-session-1"), null, "observed idle invalidates the prior recording token");
  recordOwnership(profile, "indeterminate", "fixture-version", "manager-session-1");
  assert.throws(() => ownRecording(profile, "manager-session-1"), /indeterminate/);
  recordOwnership(profile, "idle", "fixture-version", "manager-session-1");
  assert.equal(ownRecording(profile, "manager-session-1"), null);
  assert.deepEqual(parseEnvironment(wire.environment), { runtimeVersion: "1.2.043.45", mcpVersion: "1.31", platformVersion: "8.5.1.1423", vanessaExt: true, managerInfobase: { type: "server", server: "localhost", database: "ui-demo" } });
  assert.deepEqual(parseState(wire.state), { connected: false, running: false, recording: false });
  assert.deepEqual(parseEditor(wire.editor), { stateAvailable: true, tabCount: 1, errorCount: 0 });
  assert.equal((await inspectSession(profile, fixtureClient, fixtureTools, semanticContract)).editorEnabled, "unverified", "a cached editor snapshot never proves enabled state");
  assert.deepEqual(parseProfiles(wire.profiles), [{ name: "ExistingClient", infobase: { type: "server", server: "localhost", database: "ui-demo" }, additionalParameters: '/N"FixtureUser"', connected: false, pid: 0, computerName: "localhost" }]);
  assert.equal(parseInfobase('Srvr="localhost";Ref="one";Ref="two";'), null);
  assert.equal(parseInfobase('File="C:\\Demo";Srvr="localhost";Ref="one";'), null);
  assert.equal(parseEnvironment(wire.response(wire.environment.content[0].text.replace("1.31", "9.99"))).mcpVersion, "9.99");
  assert.equal(parseEnvironment(wire.response(wire.environment.content[0].text.replace("1.2.043.45", "3.0.0-future"))).runtimeVersion, "3.0.0-future");
  assert.equal(parseEnvironment(wire.response(wire.environment.content[0].text.replace("Строка соединения с информационной базой", "Неизвестное поле"))), null);
  assert.equal(parseState(wire.response(wire.state.content[0].text.replace("Выполнение сценариев: нет", "Выполнение сценариев: неизвестно"))), null);
  assert.equal(parseEditor(wire.response(wire.editor.content[0].text.replace("## Ошибки в редакторе", "## Unknown"))), null);
  assert.equal(parseProfiles(wire.response(wire.profiles.content[0].text.replace("Найдено профилей: 1", "Найдено профилей: 2"))), null);
  assert.deepEqual(parseState(wire.connectedState), { connected: true, running: false, recording: false, clientName: "TestClient" });
  assert.equal(parseExtensions(wire.extensions).length, 7);
  assert.deepEqual(parseExtensions(wire.extensions).find(item => item.name === "VAExtension"), { name: "VAExtension", version: "1.41", active: true });
  assert.equal(parseExtensions(wire.response(wire.extensions.content[0].text.replace("Итого: 7", "Итого: 8"))), null);
  const inventory = parseProcesses(wire.clientProcess);
  assert.equal(inventory.filter, "19968"); assert.equal(inventory.matchedCount, 1);
  assert.deepEqual(inventory.processes[0].launch, { infobase: { type: "server", server: "localhost", database: "ui-demo" }, user: "FixtureUser", testPort: 48000, interface: "taxi" });
  assert.equal(parseProcesses(wire.response(wire.clientProcess.content[0].text.replace("1 из 2. Показано: 1", "2 из 3. Показано: 1"))), null, "partial process inventory is never complete");
  assert.equal(parseClientLaunch('"C:\\App\\1cv8c.exe" ENTERPRISE /S"localhost\\ui-demo" /TESTCLIENT -TPort 48000 /iTaxi /itdi'), null);
  const wrongProcess = { ...semanticContract, processes: () => ({ ...semanticContract.processes(), processes: [{ ...semanticContract.processes().processes[0], launch: { ...semanticContract.processes().processes[0].launch, infobase: { type: "file", path: root } } }] }) };
  assert.equal((await inspectSession(profile, fixtureClient, fixtureTools, wrongProcess)).reason, "actual_test_client_launch_mismatch_or_unverified", "edited config row cannot hide a different actual process base");
  const ambiguousProcess = { ...semanticContract, processes: () => ({ ...semanticContract.processes(), matchedCount: 2, processes: [...semanticContract.processes().processes, ...semanticContract.processes().processes] }) };
  assert.equal((await inspectSession(profile, fixtureClient, fixtureTools, ambiguousProcess)).reason, "unique_actual_test_client_process_not_verified");
  assert.equal(parseState(wire.response("В редактор был загружен фича файл, но ещё ни разу не запускался. Для получения подробной информации о загруженном файле нужно вызвать get_editor_state.\nИмя загруженного feature файла: C:\\Projects\\UI Demo\\smoke.feature")), null, "editor-only state never implies idle or connected");

  const feature = path.join(profile.features, "smoke.feature"), scenario = "Open sample list";
  fs.writeFileSync(feature, "\uFEFF\r\n#language: en\r\nFeature: Sample\r\nScenario: Open sample list\r\n  Given sample\r\n");
  const syntaxResult = (valid, sourceFile = feature) => wire.response(JSON.stringify({ message: `# Проверка синтаксиса Gherkin\n\n- Файл: ${sourceFile}\n- Синтаксис корректен: ${valid ? "да" : "нет"}\n- Количество проблем: ${valid ? 0 : 1}\n\n${valid ? "Проблем не найдено." : "Unknown step"}`, completedAt: "15.10.2026 22:40:55" }));
  const selectionResult = wire.response("Сценарий сделан текущим. Теперь при выполнении текущего сценария будет выполнен этот сценарий.");
  const selectedEditor = (name, sourceFile = feature, buffer = normalizeFeatureText(fs.readFileSync(sourceFile, "utf8"))) => wire.response(`# Состояние редактора\n\n## Открытые вкладки\nКоличество: 2\n\n- memory:welcome\n- **→** ${sourceFile}\n\n## Активный документ\n- Строка: 3\n\n### Выбранный сценарий: ${name}\n\n### Всего сценариев в файле: 1\n### Все сценарии из файла:\n- ${name}\n\n### Содержимое\n\`\`\`gherkin\n${buffer}\n\`\`\`\n\n## Ошибки в редакторе\nКоличество: 0`);
  const workflowTools = [...fixtureTools, { name: "load_features", inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } }, { name: "select_scenario", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } }, { name: "run_scenario", inputSchema: { type: "object", properties: { mode: { type: "string" } }, additionalProperties: false } }];
  const workflowContract = { ...semanticContract, syntax: parseSyntax, selection: parseSelection, editorContent };
  let workflowMode = "valid", workflowCalls = [], opened = false, openedFeature = feature;
  const workflowClient = { request: async (method, params) => {
    workflowCalls.push(params.name);
    if (params.name === "open_feature_file") {
      if (workflowMode === "editorDisabled") return { isError: true, content: [{ type: "text", text: "Vanessa Editor отключен в настройках Vanessa Automation." }] };
      opened = true; openedFeature = params.arguments.filePath; return wire.response("Feature opened");
    }
    if (params.name === "load_features") { assert.equal(params.arguments.path, openedFeature); return wire.response("Feature reloaded"); }
    if (params.name === "check_syntax") return workflowMode === "unknownSyntax" ? wire.response("Unknown response") : syntaxResult(workflowMode !== "invalidSyntax", openedFeature);
    if (params.name === "select_scenario") return workflowMode === "unknownSelection" ? wire.response("Unknown response") : selectionResult;
    if (params.name === "get_editor_state" && opened) {
      assert.equal(params.arguments.includeContent, true);
      const buffer = normalizeFeatureText(fs.readFileSync(openedFeature, "utf8"));
      return selectedEditor(workflowMode === "wrongSelection" ? "Another scenario" : scenario, openedFeature, workflowMode === "staleBuffer" ? buffer.replace("Given sample", "Given previous buffer") : buffer);
    }
    if (params.name === "run_scenario") {
      assert.deepEqual(params.arguments, { mode: "selected" });
      if (workflowMode === "timeout") throw new Error("transport timeout");
      return wire.response("Raw terminal run report");
    }
    if (params.name === "get_test_results") return wire.response("Raw results");
    return fixtureClient.request(method, params);
  } };
  connected = true;
  const workflowOptions = { feature, scenario };
  const completedWorkflow = await runFeature(profile, workflowClient, workflowTools, workflowOptions, workflowContract);
  assert.equal(completedWorkflow.status, "completed");
  assert.equal(completedWorkflow.featureSha256, digest(fs.readFileSync(feature)));
  assert.equal(completedWorkflow.editorContentSha256, digest(normalizeFeatureText(fs.readFileSync(feature, "utf8"))));
  assert.deepEqual(workflowCalls.slice(-7), ["open_feature_file", "load_features", "check_syntax", "select_scenario", "get_editor_state", "run_scenario", "get_test_results"]);
  assert.equal(editorContent(selectedEditor(scenario)).startsWith("\n#language"), true, "leading document blank is preserved");
  assert.equal(editorContent(selectedEditor(scenario, feature, "first\n```\nsecond")), null, "ambiguous embedded fences fail closed");
  for (const mode of ["unknownSyntax", "invalidSyntax", "unknownSelection", "wrongSelection", "staleBuffer"]) {
    workflowMode = mode; workflowCalls = []; opened = false;
    assert.equal((await runFeature(profile, workflowClient, workflowTools, workflowOptions, workflowContract)).status, "error");
    assert.equal(workflowCalls.includes("run_scenario"), false, `${mode} blocks execution`);
  }
  workflowMode = "timeout"; workflowCalls = []; opened = false;
  await assert.rejects(runFeature(profile, workflowClient, workflowTools, workflowOptions, workflowContract), error => error.code === "mutation_indeterminate" && error.detail.tool === "run_scenario");
  assert.equal(workflowCalls.filter(name => name === "run_scenario").length, 1);
  assert.equal(workflowCalls.includes("get_test_results"), false, "mutation timeout never retries or assumes completion");
  workflowMode = "editorDisabled"; workflowCalls = []; opened = false;
  await assert.rejects(runFeature(profile, workflowClient, workflowTools, workflowOptions, workflowContract), error => error.code === "tool_error" && error.detail.outcome === "responded");
  assert.equal(workflowCalls.includes("run_scenario"), false, "cached editor state cannot bypass actual disabled-editor error");
  workflowCalls = []; opened = false;
  const earlyContract = { ...workflowContract, state: () => null };
  assert.equal((await runFeature(profile, workflowClient, workflowTools, workflowOptions, earlyContract)).stage, "readiness");
  assert.equal(workflowCalls.includes("open_feature_file"), false, "editor-only initial state is fail-closed before mutation");
  const copyDir = path.join(root, ".acceptance"); fs.mkdirSync(copyDir);
  const acceptedFeature = path.join(copyDir, "repair.feature"); fs.copyFileSync(feature, acceptedFeature);
  workflowMode = "valid"; workflowCalls = []; opened = false;
  assert.equal((await runFeature(profile, workflowClient, workflowTools, { feature: acceptedFeature, scenario }, workflowContract)).status, "completed", "explicit ignored copy inside projectRoot is supported");
  await assert.rejects(runFeature({ ...profile, projectRoot: profile.features }, workflowClient, workflowTools, { feature: acceptedFeature, scenario }, workflowContract), /inside projectRoot or configured features/, "arbitrary parent-directory feature is rejected");
  let notifyAwaiting;
  const waiting = new Promise(resolve => { notifyAwaiting = resolve; });
  const handoffInput = new PassThrough(); let progress;
  workflowMode = "valid"; workflowCalls = []; opened = false;
  const continuedRun = runFeature(profile, workflowClient, workflowTools, { ...workflowOptions,
    beforeOpen: () => awaitEditorTransition({ input: handoffInput, output: { write: text => { progress = JSON.parse(text); notifyAwaiting(); } }, timeoutMs: 1000, managerPid: 12345 }),
  }, workflowContract);
  await waiting;
  assert.equal(progress.status, "awaiting_editor_enable"); assert.equal(progress.managerPid, 12345);
  assert.equal(workflowCalls.includes("open_feature_file"), false, "lock/session transition pauses before the first editor mutation");
  handoffInput.write('{"action":"continue"}\n');
  assert.equal((await continuedRun).status, "completed");
  for (const bad of ['{"action":"stop"}\n', '{"action":"continue","command":"anything"}\n', '{"action":"continue"}\n{"action":"continue"}\n']) {
    const input = new PassThrough();
    const rejected = awaitEditorTransition({ input, output: { write: () => {} }, timeoutMs: 1000 });
    input.write(bad); await assert.rejects(rejected, /transition/);
  }
  await assert.rejects(awaitEditorTransition({ input: new PassThrough(), output: { write: () => {} }, timeoutMs: 5 }), /timed out/);
  const endedInput = new PassThrough(), ended = awaitEditorTransition({ input: endedInput, output: { write: () => {} }, timeoutMs: 1000 });
  endedInput.end(); await assert.rejects(ended, /closed/);

  // Exercise the real HTTP session deadline around the entire workflow. A
  // rejected mock request alone cannot reproduce the outer Promise.race.
  const base = { type: "server", server: "localhost", database: "ui-demo" };
  write({ ...raw, manager: { infobase: base }, client: { name: "TestClient", infobase: base }, limits: { timeoutMs: 1500 } });
  networkTools = workflowTools;
  const rewrite = (response, change) => wire.response(change(response.content[0].text));
  let httpMode = "success";
  networkCall = (name, args) => {
    const failedTool = httpMode.endsWith("Results") ? "get_test_results" : "run_scenario";
    if (name === failedTool && httpMode.startsWith("timeout")) return undefined;
    if (name === failedTool && httpMode.startsWith("toolError")) return { isError: true, content: [{ type: "text", text: "fixture runtime rejected operation; Password=fixture-secret" }] };
    const responses = {
      get_environment_data: () => wire.environment,
      get_vanessa_automation_state: () => wire.connectedState,
      manage_test_client_profiles: () => rewrite(wire.profiles, text => text.replaceAll("ExistingClient", "TestClient").replace('/N"FixtureUser"', '/iTaxi /N"FixtureUser"').replace("❌ не подключен", "✅ подключен")),
      get_editor_state: () => args.includeContent ? selectedEditor(scenario) : wire.editor,
      get_process_list_os: () => rewrite(wire.clientProcess, text => text.replace("Отбор: 19968.", "Отбор: /TESTCLIENT.")),
      get_extension_list: () => wire.extensions,
      check_syntax: () => syntaxResult(true),
      select_scenario: () => selectionResult,
    };
    return responses[name]?.() ?? wire.response("synthetic operation/result");
  };
  const networkOptions = ["run", "--profile", profileFile, "--feature", feature, "--scenario", scenario];
  const networkCompleted = await main([...networkOptions]);
  assert.equal(networkCompleted.status, "completed");
  assert.equal(JSON.parse(fs.readFileSync(networkCompleted.receipt)).status, "unverified", "raw result text never becomes a passing test");
  for (const variant of ["timeoutRun", "timeoutResults", "toolErrorRun", "toolErrorResults"]) {
    httpMode = variant; calls = [];
    const responded = variant.startsWith("toolError"), tool = variant.endsWith("Results") ? "get_test_results" : "run_scenario";
    await assert.rejects(main([...networkOptions]), error => {
      assert.equal(error.detail.tool, tool);
      assert.equal(error.detail.classification, responded ? "tool_error" : "transport_or_protocol");
      assert.equal(error.detail.outcome, responded ? "responded" : tool === "run_scenario" ? "indeterminate" : "unverified");
      assert.ok(error.detail.reports.check_syntax);
      const receipt = JSON.parse(fs.readFileSync(error.detail.receipt));
      assert.equal(receipt.status, "unverified");
      const saved = fs.readFileSync(receipt.resultsFile, "utf8");
      assert.ok(!saved.includes("fixture-secret"));
      if (responded) assert.match(saved, /fixture runtime rejected operation/);
      return true;
    });
    assert.equal(calls.filter(item => item.method === "tools/call" && item.params.name === "run_scenario").length, 1, "never replay the dispatched mutation");
    assert.equal(calls.filter(item => item.method === "tools/call" && item.params.name === "get_test_results").length, tool === "run_scenario" ? 0 : 1);
  }
  console.log("Vanessa UI profile/isolation/schema/HTTP/readiness/error checks passed");
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  os.tmpdir = nativeTmpdir;
  const resolved = path.resolve(root), tempRoot = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("vanessa-ui-contract-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
