import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers.mjs";
import * as wire from "./test-vanessa-ui-fixtures.mjs";
import { inspectSession, requiredTools, runtimeContract, setupSession } from "../vanessa/readiness.mjs";
import { parseClientIdentity, parseClientLaunch, parseProcesses, parseProfiles } from "../vanessa/runtime-contract.mjs";
import { runFeature } from "../vanessa/run.mjs";
import { start } from "../vanessa/runtime.mjs";

function runtime(t, { fileBase = false } = {}) {
  const f = fixture(t), basePath = path.join(f.root, "database"), alias = path.join(f.root, "database-alias");
  fs.mkdirSync(basePath);
  fs.symlinkSync(basePath, alias, process.platform === "win32" ? "junction" : "dir");
  const manager = { type: "server", server: "localhost", database: "ui-demo" };
  const base = fileBase ? { type: "file", path: basePath } : manager;
  const profile = { identity: "fixture", stateDir: f.state, projectRoot: f.root, features: f.root, results: f.state,
    mcp: { url: "http://localhost:9876/mcp" }, manager: { infobase: manager },
    client: { name: "TestClient", infobase: base, computerName: "localhost" } };
  const tools = [...requiredTools, "load_features", "select_scenario", "run_scenario"].map(name => ({ name, inputSchema: { type: "object" } }));
  const rewrite = (response, change) => wire.response(change(response.content[0].text));
  const profileText = wire.profiles.content[0].text.replaceAll("ExistingClient", "TestClient")
    .replace('/N"FixtureUser"', '/iTaxi /N"FixtureUser"').replace("| PID | 0 |", "| PID | 19968 |")
    .replace("❌ не подключен", "✅ подключен");
  const selectedProfile = fileBase ? profileText.replace('Srvr="localhost";Ref="ui-demo";', `File="${basePath}";`) : profileText;
  const otherProfile = selectedProfile.replaceAll("TestClient", "OtherClient").replaceAll("FixtureUser", "OtherUser").replace("| PID | 19968 |", "| PID | 20001 |");
  let processes = wire.clientProcess.content[0].text.replace("Найдено по отбору: 1 из 2. Показано: 1.", "Найдено: 2. Показано: 2.").replace("Отбор: 19968.\n", "");
  if (fileBase) processes = processes.replace('/S"localhost\\ui-demo"', `/F"${basePath}"`);
  const baseArgument = fileBase ? `/F"${alias}"` : '/S"localhost\\other-demo"';
  const second = `\n| 20001 | 15.10.2026 22:30:00 | "C:\\App\\1cv8c.exe" ENTERPRISE ${baseArgument} /TESTCLIENT -TPort 48001 /iTaxi /N"OtherUser" |`;
  processes += second;
  let switched = false, stateOverride = null, editorScenario = "Example", onProcess = () => {}, onEditorContent = () => {};
  let created = "win32-filetime:123456", binding = { managerPid: 99999, managerCreated: "win32-filetime:123400" };
  const contract = { ...runtimeContract, processIdentity: pid => created && ({ pid, executable: "C:\\Fixture\\1cv8c.exe", created }), processBinding: () => binding };
  const calls = [], requests = [];
  const client = { request: async (_method, args) => {
    calls.push(args.name);
    requests.push(args);
    if (args.name === "get_process_list_os") { onProcess(); return wire.response(processes); }
    if (args.name === "manage_test_client_profiles") return wire.response(switched ? otherProfile : selectedProfile);
    if (args.name === "get_vanessa_automation_state") return stateOverride || (switched ? rewrite(wire.connectedState, text => text.replaceAll("TestClient", "OtherClient")) : wire.connectedState);
    if (args.name === "get_environment_data") return wire.environment;
    if (args.name === "get_extension_list") return wire.extensions;
    if (args.name === "get_editor_state") {
      if (!args.arguments.includeContent) return wire.editor;
      onEditorContent();
      return wire.response(`# Состояние редактора\n\n## Открытые вкладки\nКоличество: 1\n\n- **→** ${feature}\n\n## Активный документ\n\n### Выбранный сценарий: ${editorScenario}\n\n### Все сценарии из файла:\n- ${editorScenario}\n\n### Содержимое\n\`\`\`gherkin\n${content}\n\`\`\`\n\n## Ошибки в редакторе\nКоличество: 0`);
    }
    if (args.name === "check_syntax") return wire.response(`# Проверка синтаксиса Gherkin\n\n- Файл: ${feature}\n- Синтаксис корректен: да\n- Количество проблем: 0`);
    if (args.name === "select_scenario") return wire.response("Сценарий сделан текущим. Теперь при выполнении текущего сценария будет выполнен этот сценарий.");
    return wire.response("ok");
  } };
  const feature = path.join(f.root, "example.feature"), content = "Feature: Example\nScenario: Example\n  Given example\n";
  fs.writeFileSync(feature, content);
  return { profile, tools, client, calls, requests, contract, feature, alias, second,
    changeProcesses: fn => { processes = fn(processes); }, switchClient: () => { switched = true; },
    onProcess: fn => { onProcess = fn; }, onEditorContent: fn => { onEditorContent = fn; },
    setScenario: value => { editorScenario = value; }, setState: value => { stateOverride = value; },
    changeIdentity: value => { created = value; }, changeBinding: value => { binding = value; } };
}

test("TCP binding distinguishes clients even when launch users or bases are ambiguous", async t => {
  const f = runtime(t);
  f.changeProcesses(text => text.replace('/S"localhost\\other-demo"', '/S"localhost\\ui-demo"').replace(' /N"OtherUser" |', " |"));
  assert.equal((await inspectSession(f.profile, f.client, f.tools, f.contract)).status, "ready");
  const alias = runtime(t, { fileBase: true });
  alias.changeProcesses(text => text.replace(' /N"OtherUser" |', ' /N"FixtureUser" |'));
  assert.equal((await inspectSession(alias.profile, alias.client, alias.tools, alias.contract)).status, "ready");
});

test("different /N values or server aliases do not prove a different authenticated client", async t => {
  const f = runtime(t);
  f.changeProcesses(text => text.replace('/S"localhost\\other-demo"', '/S"127.0.0.1\\ui-demo"'));
  assert.equal((await inspectSession(f.profile, f.client, f.tools, f.contract)).status, "ready");
});

test("an unrelated client need not use the selected client's launch options", async t => {
  const f = runtime(t);
  f.changeProcesses(text => text.replace(" -TPort 48001 /iTaxi", " /iTDI"));
  assert.equal((await inspectSession(f.profile, f.client, f.tools, f.contract)).status, "ready");
  assert.equal(parseClientIdentity('"C:\\App\\1cv8c.exe" ENTERPRISE /S"localhost\\other" /TESTCLIENT /iTDI /N"Other"').user, "Other");
  assert.equal(parseClientLaunch('"C:\\App\\1cv8c.exe" ENTERPRISE /S"localhost\\other" /TESTCLIENT /iTaxi /N"Other"').testPort, 1538);
  assert.equal(parseClientLaunch('"C:\\App\\1cv8c.exe" ENTERPRISE /S"localhost\\other" /TESTCLIENT -TPort48001 /iTaxi /N"Other"').testPort, 48001);
  assert.equal(parseClientLaunch('"C:\\App\\1cv8c.exe" ENTERPRISE /S"localhost\\other" /TESTCLIENT -TPortbad /iTaxi /N"Other"'), null);
  assert.equal(parseClientIdentity('"C:\\App\\1cv8c.exe" ENTERPRISE /S"localhost\\other" /TESTCLIENT /N -TPort 48001 /iTaxi'), null);
});

test("a client switch during process discovery prevents readiness", async t => {
  const f = runtime(t); f.onProcess(f.switchClient);
  assert.equal((await inspectSession(f.profile, f.client, f.tools, f.contract)).reason, "session_changed_during_readiness");
});

test("a client switch during the editor handoff blocks the first mutation", async t => {
  const f = runtime(t);
  const result = await runFeature(f.profile, f.client, f.tools, { feature: f.feature, scenario: "Example", beforeOpen: f.switchClient }, f.contract);
  assert.equal(result.reason, "client_binding_changed_or_unverified");
  assert.equal(f.calls.includes("open_feature_file"), false);
});

test("a reused PID within the same displayed second blocks the first mutation", async t => {
  const f = runtime(t);
  const result = await runFeature(f.profile, f.client, f.tools, { feature: f.feature, scenario: "Example",
    beforeOpen: () => f.changeIdentity("win32-filetime:123457") }, f.contract);
  assert.equal(result.reason, "client_binding_changed_or_unverified");
  assert.equal(f.calls.includes("open_feature_file"), false);
});

for (const [name, state, reason] of [
  ["recording", wire.response(wire.connectedState.content[0].text.replace("Включена запись действий пользователя: нет", "Включена запись действий пользователя: да")), "session_busy_with_scenario_or_recording"],
  ["running", wire.response(wire.connectedState.content[0].text.replace("Выполнение сценариев: нет", "Выполнение сценариев: да")), "session_busy_with_scenario_or_recording"],
  ["editor-only state", wire.response("В редактор был загружен фича файл, но ещё ни разу не запускался."), "session_state_response_contract_unverified"],
]) test(`a ${name} after the editor handoff blocks the first mutation`, async t => {
  const f = runtime(t);
  const result = await runFeature(f.profile, f.client, f.tools, { feature: f.feature, scenario: "Example", beforeOpen: () => f.setState(state) }, f.contract);
  assert.equal(result.reason, reason);
  assert.equal(f.calls.includes("open_feature_file"), false);
});

test("a client switch while opening the editor blocks scenario execution", async t => {
  const f = runtime(t); let checks = 0; f.onProcess(() => { if (++checks === 2) f.switchClient(); });
  const result = await runFeature(f.profile, f.client, f.tools, { feature: f.feature, scenario: "Example" }, f.contract);
  assert.equal(result.reason, "client_binding_changed_or_unverified");
  assert.equal(f.calls.includes("run_scenario"), false);
});

test("a changed editor selection during the binding check blocks scenario execution", async t => {
  const f = runtime(t); let checks = 0;
  f.onProcess(() => { if (++checks === 2) f.setScenario("Other"); });
  const result = await runFeature(f.profile, f.client, f.tools, { feature: f.feature, scenario: "Example" }, f.contract);
  assert.equal(result.reason, "selected_scenario_or_file_unverified");
  assert.equal(f.calls.includes("run_scenario"), false);
});

test("complete process inventory refuses hidden command lines and argument files", async t => {
  const f = runtime(t);
  assert.equal((await inspectSession(f.profile, f.client, f.tools, f.contract)).status, "ready");
  const request = f.requests.find(item => item.name === "get_process_list_os");
  assert.deepEqual(request.arguments, { only_1c: true, limit: 0 });
  f.changeProcesses(text => text.replace(f.second, '\n| 20001 | 15.10.2026 22:30:00 |  |'));
  assert.equal((await inspectSession(f.profile, f.client, f.tools, f.contract)).reason, "unique_actual_test_client_process_not_verified");
  f.changeProcesses(text => text.replace('| 20001 | 15.10.2026 22:30:00 |  |', '| 20001 | 15.10.2026 22:30:00 | "C:\\App\\1cv8c.exe" /@"C:\\args.txt" |'));
  assert.equal((await inspectSession(f.profile, f.client, f.tools, f.contract)).reason, "unique_actual_test_client_process_not_verified");
  f.changeProcesses(text => text.replace('/@"C:\\args.txt"', 'ENTERPRISE /TESTCLIENT /@"C:\\args.txt"'));
  assert.equal((await inspectSession(f.profile, f.client, f.tools, f.contract)).reason, "unique_actual_test_client_process_not_verified");
  const command='"C:\\App\\1cv8c.exe" ENTERPRISE /S"localhost\\ui-demo" /TESTCLIENT /iTaxi';
  for (const suffix of [' /@"C:\\args.txt"', ' /IBName"other"', ' /WS"https://example.invalid"']) {
    assert.equal(parseClientIdentity(command + suffix), null);
    assert.equal(parseClientLaunch(command + suffix), null);
  }
});

test("unfiltered two-column process lists work and filtered or truncated inventories fail closed", async t => {
  const f=runtime(t);
  f.changeProcesses(text => text.replace("| PID | Запущен | Командная строка |", "| PID | Командная строка |")
    .replace("|-----|---------|------------------|", "|-----|------------------|")
    .replace(/\| (19968|20001) \| [^|]* \| /g, "| $1 | "));
  assert.equal((await inspectSession(f.profile, f.client, f.tools, f.contract)).status, "ready");
  f.changeProcesses(text => text.replace("Найдено: 2. Показано: 2.", "Найдено по отбору: 2 из 2. Показано: 2.\nОтбор: /TESTCLIENT."));
  assert.equal((await inspectSession(f.profile, f.client, f.tools, f.contract)).reason, "unique_actual_test_client_process_not_verified");
  const truncated=wire.response(wire.clientProcess.content[0].text.replace("Показано: 1.", "Показано: 0."));
  assert.equal(parseProcesses(truncated), null);
});

test("unrelated process arguments never enter readiness evidence", async t => {
  const f=runtime(t), secret="opaque-private-argument";
  f.changeProcesses(text=>text.replace("Найдено: 2. Показано: 2.", "Найдено: 3. Показано: 3.")+
    `\n| 30001 | 15.10.2026 22:30:00 | "C:\\App\\1cv8.exe" ENTERPRISE /C${secret} |`);
  const result=await inspectSession(f.profile,f.client,f.tools,f.contract);
  assert.equal(result.status,"ready");assert.equal(JSON.stringify(result).includes(secret),false);
});

test("missing or replaced process or TCP proof blocks mutation", async t => {
  for (const change of [f=>f.changeIdentity(null),f=>f.changeBinding(null)]) {
    const f=runtime(t);change(f);
    const result=await runFeature(f.profile,f.client,f.tools,{feature:f.feature,scenario:"Example"},f.contract);
    assert.equal(result.stage,"readiness");assert.equal(f.calls.includes("open_feature_file"),false);
  }
  const f=runtime(t);
  const result=await runFeature(f.profile,f.client,f.tools,{feature:f.feature,scenario:"Example",
    beforeOpen:()=>f.changeBinding({managerPid:99999,managerCreated:"win32-filetime:123401"})},f.contract);
  assert.equal(result.reason,"manager_test_client_connection_unverified");assert.equal(f.calls.includes("open_feature_file"),false);
});

test("a launch user does not prove the authenticated user or authorize a scenario", async t => {
  const f=runtime(t),profile={...f.profile,client:{...f.profile.client,user:"FixtureUser"}};
  const result=await runFeature(profile,f.client,f.tools,{feature:f.feature,scenario:"Example"},f.contract);
  assert.equal(result.stage,"readiness");assert.equal(result.reason,"actual_test_client_user_unverified");
  assert.equal(f.calls.includes("open_feature_file"),false);assert.equal(f.calls.includes("run_scenario"),false);
});

test("an unverified configured client user blocks setup before profile creation or connection", async t => {
  const f=runtime(t),profile={...f.profile,client:{...f.profile.client,user:"FixtureUser"}};
  assert.equal((await start(profile)).reason,"actual_test_client_user_unverified");
  const mutations=[];f.setState(wire.state);
  const client={request:async(method,args)=>{
    if(args.name==="manage_test_client_profiles" && args.arguments.action==="get_list")return wire.emptyProfiles;
    if(args.name==="manage_test_client_profiles" || args.name==="manage_test_client")mutations.push(args);
    return f.client.request(method,args);
  }};
  const result=await setupSession(profile,client,f.tools,f.contract);
  assert.equal(result.reason,"actual_test_client_user_unverified");assert.deepEqual(mutations,[]);
});

test("an unverified client user blocks the computer-name repair mutation", async t => {
  const f=runtime(t),profile={...f.profile,client:{...f.profile.client,user:"FixtureUser"}};
  const mutations=[];f.setState(wire.state);
  const client={request:async(method,args)=>{
    if(args.name==="manage_test_client_profiles" && args.arguments.action!=="get_list")mutations.push(args);
    const result=await f.client.request(method,args);
    return args.name==="manage_test_client_profiles" && args.arguments.action==="get_list"
      ?wire.response(result.content[0].text.replace("| Имя компьютера | localhost |","| Имя компьютера | stalehost |")):result;
  }};
  const result=await setupSession(profile,client,f.tools,f.contract);
  assert.equal(result.reason,"actual_test_client_user_unverified");assert.deepEqual(mutations,[]);
});

test("an unverified manager user blocks launch and all dependent mutations", async t => {
  const f=runtime(t),profile={...f.profile,manager:{...f.profile.manager,user:"ManagerUser"}};
  assert.equal((await start(profile)).reason,"manager_session_user_unverified");
  assert.equal((await setupSession(profile,f.client,f.tools,f.contract)).reason,"manager_session_user_unverified");
  assert.equal((await runFeature(profile,f.client,f.tools,{feature:f.feature,scenario:"Example"},f.contract)).reason,"manager_session_user_unverified");
  assert.equal(f.requests.some(item=>item.name==="manage_test_client" || item.name==="manage_test_client_profiles" && item.arguments.action!=="get_list"),false);
  assert.equal(f.calls.includes("open_feature_file"),false);
});

test("launch also blocks an unverified primary user when another client is selected", async t => {
  const f=runtime(t),profile={...f.profile,client:{...f.profile.client,name:"Other"},ownerClient:{...f.profile.client,user:"PrimaryUser"}};
  assert.equal((await start(profile)).reason,"actual_test_client_user_unverified");
});

test("userEnv cannot authorize a launch or connection when its value changes", async t => {
  const f=runtime(t),key="VANESSA_READINESS_FIXTURE_USER",before=process.env[key];
  t.after(()=>{if(before===undefined)delete process.env[key];else process.env[key]=before;});
  const manager={...f.profile,manager:{...f.profile.manager,userEnv:key}};
  const client={...f.profile,client:{...f.profile.client,userEnv:key}};
  f.setState(wire.state);const mutations=[];
  const transport={request:async(method,args)=>{
    if(args.name==="manage_test_client_profiles"&&args.arguments.action==="get_list")return wire.emptyProfiles;
    if(args.name==="manage_test_client_profiles"||args.name==="manage_test_client")mutations.push(args);
    return f.client.request(method,args);
  }};
  for(const value of ["FirstUser","SecondUser"]){
    process.env[key]=value;
    assert.equal((await start(manager)).reason,"manager_session_user_unverified");
    assert.equal((await start(client)).reason,"actual_test_client_user_unverified");
    assert.equal((await setupSession(client,transport,f.tools,f.contract)).reason,"actual_test_client_user_unverified");
  }
  assert.deepEqual(mutations,[]);
});

test("an abbreviated editor state after selection blocks scenario execution", async t => {
  const f=runtime(t);let checks=0;
  f.onProcess(()=>{if(++checks===2)f.setState(wire.response("В редактор был загружен фича файл, но ещё ни разу не запускался."));});
  const result=await runFeature(f.profile,f.client,f.tools,{feature:f.feature,scenario:"Example"},f.contract);
  assert.equal(result.reason,"session_state_response_contract_unverified");assert.equal(f.calls.includes("run_scenario"),false);
});

test("setup recognizes upstream empty profiles and creates the first client", async t => {
  const f=runtime(t);let created=false,connected=false;const mutations=[];
  assert.deepEqual(parseProfiles(wire.emptyProfiles),[]);
  assert.equal(parseProfiles(wire.response(wire.emptyProfiles.content[0].text+"\n## Профиль: unexpected")),null);
  assert.equal(parseProfiles(wire.response("# Список профилей клиентов тестирования\n\nПрофили не настроены.")),null);
  const client={request:async(method,args)=>{
    if(args.name==="manage_test_client_profiles"){
      if(args.arguments.action==="add"){mutations.push("add");created=true;return wire.response("created");}
      if(!created)return wire.emptyProfiles;
      const selected=wire.profiles.content[0].text.replaceAll("ExistingClient","TestClient")
        .replace('/N"FixtureUser"','/iTaxi /N"FixtureUser"').replace("| PID | 0 |","| PID | 19968 |")
        .replace("❌ не подключен",connected?"✅ подключен":"❌ не подключен");
      return wire.response(selected);
    }
    if(args.name==="get_vanessa_automation_state")return connected?wire.connectedState:wire.state;
    if(args.name==="manage_test_client"){mutations.push("connect");connected=true;return wire.response("connected");}
    return f.client.request(method,args);
  }};
  const result=await setupSession(f.profile,client,f.tools,f.contract);
  assert.equal(result.status,"ready");assert.deepEqual(mutations,["add","connect"]);
});
