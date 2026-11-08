import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, dialog_session } from "./helpers.mjs";
import { save_export_to_path, state_export_path, save_state_export } from "../scripts/settings_export.mjs";
import { parse, dump } from "../scripts/common.mjs";
import { read_diagnostic_logs } from "../scripts/diagnostics.mjs";

async function platform_session(t, f, platform) {
  return (await dialog_session(t, f, { platform })).client;
}

test("project export uses the chosen destination and keeps file contents app-only", async t => {
  const f=fixture(t);f.save();const {client,choose}=await dialog_session(t,f), target=path.join(f.base,"chosen.yaml");choose(target);
  const response=await client.call("settings.transfer_export",{scope:"profile",projectRoot:f.root}),saved=response._meta.data;
  assert.equal(saved.path,target);
  assert.deepEqual(parse(fs.readFileSync(saved.path,"utf8")),f.profile);
  assert.equal(response.structuredContent,undefined);
  assert.ok(!JSON.stringify(response.content).includes(f.state));
  assert.equal(saved.filename,"chosen.yaml");
});

test("failed settings export leaves the previous file intact and does not claim a saved file", t => {
  const f=fixture(t), target=path.join(f.base,"settings-export.json");
  assert.throws(()=>save_export_to_path("",{text:"{}"}),/абсолютный путь/);
  assert.throws(()=>save_export_to_path(target,{}),/отсутствует/);
  const saved=save_export_to_path(target,{text:"{}"});
  assert.throws(()=>save_export_to_path(target,{text:"x".repeat(2*1024*1024+1)}),/превышает/);
  assert.equal(fs.readFileSync(saved.path,"utf8"),"{}");
  fs.rmSync(saved.path);fs.mkdirSync(saved.path);
  assert.throws(()=>save_export_to_path(target,{text:"{}"}));
  assert.ok(fs.statSync(saved.path).isDirectory());
});

test("diagnostics export records the failing stage and sanitized reason, then includes them in a later report", async t => {
  const f = fixture(t); f.save();
  const { client, choose, failDialog } = await dialog_session(t, f);
  const url = "https://alice:pw@example.invalid/mcp?token=url-token#fragment";
  failDialog({ message: `Save As failed for C:/logs/report.json URL=${url} password=dialog-secret`, code: "EACCES" });
  assert.equal((await client.request("tools/call", { name: "settings.export_diagnostics", arguments: {} })).isError, true);
  choose(path.join(f.root, "src", "report.json"));
  assert.equal((await client.request("tools/call", { name: "settings.export_diagnostics", arguments: {} })).isError, true);
  choose(f.base);
  assert.equal((await client.request("tools/call", { name: "settings.export_diagnostics", arguments: {} })).isError, true);
  const events = read_diagnostic_logs(f.state).events;
  const failures = events.filter(event => event.event === "support_export_failed");
  assert.deepEqual(failures.map(event => event.detail.stage), ["choose_destination", "validate_destination", "write_file"]);
  assert.deepEqual(failures.map(event => event.detail.stageLabel), ["Выбор файла", "Проверка пути", "Запись и проверка файла"]);
  assert.match(failures[0].detail.error.message, /Save As failed for C:\/logs\/report\.json/);
  assert.ok(failures[0].detail.error.message.includes(url));
  assert.equal(failures[0].detail.error.code, "EACCES");
  assert.equal(failures[1].detail.destination, path.join(f.root, "src", "report.json"));
  assert.doesNotMatch(JSON.stringify(failures), /dialog-secret/);
  assert.ok(failures.every(event => event.detail.projectRoot === f.root && event.detail.requestId !== undefined));
  for (const failure of failures) {
    const request = events.find(event => event.event === "request_failed" && event.detail.requestId === failure.detail.requestId);
    assert.equal(request.detail.stage, failure.detail.stage); assert.equal(request.detail.error.message, failure.detail.error.message);
  }
  const target = path.join(f.base, "diagnostics.json"); choose(target);
  await client.call("settings.export_diagnostics", {});
  const report = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.ok(report.events.some(event => event.event === "support_export_failed" && event.detail.stage === "choose_destination" && /Save As failed/.test(event.detail.error.message)));
  assert.ok(report.events.some(event => event.event === "support_export_failed" && event.detail.error.message.includes(url)));
  assert.doesNotMatch(JSON.stringify(report), /dialog-secret/);
});

test("an unbound settings session retains its own export failure details", async t => {
  const f = fixture(t), { client, choose, failDialog } = await dialog_session(t, f, { extra: { EDT_AI_PROJECT_ROOT: "" }, roots: [] });
  client.notify("notifications/roots/list_changed");
  failDialog({ message: "Save As unavailable", code: "EACCES" });
  assert.equal((await client.request("tools/call", { name: "settings.export_diagnostics", arguments: {} })).isError, true);
  const target = path.join(f.base, "unbound-diagnostics.json"); choose(target);
  await client.call("settings.export_diagnostics", {});
  const report = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(report.snapshot.host.selectedRoot, null);
  const failure = report.events.find(event => event.event === "support_export_failed");
  assert.equal(failure.scope, "session"); assert.equal(failure.detail.stage, "choose_destination");
  assert.equal(failure.detail.error.message, "Save As unavailable");
});

test("an export interrupted by project selection records both failures against its original project", async t => {
  const f = fixture(t); f.save();
  const other = path.join(f.base, "other-project"); fs.mkdirSync(other); fs.mkdirSync(path.join(other, "src"));
  dump(f.profile, path.join(other, ".ai", "project.yaml"));
  const { client, holdDialog } = await dialog_session(t, f, { extra: { EDT_AI_PROJECT_ROOT: "" }, roots: [] });
  client.notify("notifications/roots/list_changed");
  await client.call("settings.select_profile", { projectRoot: f.root });
  const dialog = holdDialog(path.join(f.base, "interrupted-report.json"));
  const pending = client.request("tools/call", { name: "settings.export_diagnostics", arguments: {} });
  try {
    await dialog.wait();
    await client.call("settings.select_profile", { projectRoot: other });
  } finally { dialog.release(); }
  assert.equal((await pending).isError, true);
  const failures = read_diagnostic_logs(f.state).events.filter(event => ["support_export_failed", "request_failed"].includes(event.event) && event.detail.stage === "validate_destination");
  assert.equal(failures.length, 2);
  assert.ok(failures.every(event => event.detail.projectRoot === f.root));
});

for (const platform of ["linux", "darwin"]) test(`${platform} exports settings and diagnostics to confirmed state files`, async t => {
  const f = fixture(t); f.save();
  const client = await platform_session(t, f, platform);
  const settings = await client.call("settings.transfer_export", {scope:"profile",projectRoot:f.root}), report = await client.call("settings.export_diagnostics", {});
  assert.equal(settings.structuredContent, undefined); assert.equal(report.structuredContent, undefined);
  assert.equal(settings._meta.data.path, path.join(f.state, "exports", "project.yaml"));
  assert.equal(report._meta.data.path, path.join(f.state, "diagnostics", "exports", "1c-ai-core-diagnostics.json"));
  assert.equal(settings._meta.data.canOpenDirectory, false); assert.equal(report._meta.data.canOpenDirectory, false);
  assert.equal(parse(fs.readFileSync(settings._meta.data.path, "utf8")).profile_id, f.profile.profile_id);
  assert.equal(JSON.parse(fs.readFileSync(report._meta.data.path, "utf8")).format, "1c-ai-core-diagnostics");
  assert.equal((await client.call("settings.transfer_export", {scope:"profile",projectRoot:f.root}))._meta.data.path, settings._meta.data.path);
});

test("state export cannot replace an explicitly configured connections file", async t => {
  const f = fixture(t); f.save();
  const file = state_export_path(f.state, "project_profile"); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "schema_version: '0.2'\n"); f.env.EDT_AI_CONNECTIONS_FILE = file;
  const client = await platform_session(t, f, "linux");
  await assert.rejects(client.call("settings.transfer_export", {scope:"profile",projectRoot:f.root}), /служебное состояние/i);
  assert.equal(fs.readFileSync(file, "utf8"), "schema_version: '0.2'\n");
});

test("state export rejects linked directories and changed destinations", t => {
  const f = fixture(t), other = path.join(f.base, "other"); fs.mkdirSync(other);
  const file = state_export_path(f.state, "project_profile");
  assert.throws(() => save_state_export(f.state, "project_profile", { text: "{}" }, path.join(f.base, "wrong.yaml")), /изменился/);
  fs.symlinkSync(other, path.join(f.state, "exports"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => save_state_export(f.state, "project_profile", { text: "{}" }, file), /ссылкой/);
  assert.deepEqual(fs.readdirSync(other), []);
});
