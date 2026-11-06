import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, dialog_session, ROOT } from "./helpers.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { save_export_to_path, state_export_path, save_state_export } from "../scripts/settings_export.mjs";
import { parse } from "../scripts/common.mjs";

async function platform_session(t, f, platform) {
  const entry = path.join(f.base, "platform-entry.mjs");
  fs.writeFileSync(entry, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "mcp/settings.mjs")).href)});`);
  const client = new McpClient([process.execPath, entry], f.root, f.env, 10);
  f.clients.push(client); await client.initialize(); return client;
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
