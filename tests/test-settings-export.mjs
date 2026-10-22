import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, session } from "./helpers.mjs";
import { save_settings_export, saved_settings_export } from "../scripts/settings_export.mjs";

test("portable export is saved on disk, replaces the previous export, and preserves its API", async t => {
  const f=fixture(t);f.save();const client=await session(t,"mcp/settings.mjs",[],f);
  await assert.rejects(client.call("settings.open_export_directory",{}),/Сначала сохраните/);
  const data=(await client.call("settings.export_data",{}))._meta.data;
  const response=await client.call("settings.save_export",{}),saved=response._meta.data;
  assert.equal(saved.path,path.join(f.state,"exports","1c-ai-core-settings.json"));
  assert.equal(fs.readFileSync(saved.path,"utf8"),data.text);
  assert.deepEqual(JSON.parse(data.text).profile,f.profile);
  assert.equal(response.structuredContent,undefined);
  assert.ok(!JSON.stringify(response.content).includes(f.state));
  const replacement=JSON.stringify({format:"fixture",value:2});
  assert.equal(save_settings_export(f.state,{text:replacement}).path,saved.path);
  assert.equal(fs.readFileSync(saved.path,"utf8"),replacement);
  assert.deepEqual(fs.readdirSync(path.dirname(saved.path)),[saved.filename]);
});

test("failed settings export leaves the previous file intact and does not claim a saved file", t => {
  const f=fixture(t);
  assert.equal(saved_settings_export(f.state),null);
  assert.throws(()=>save_settings_export(f.state,{}),/отсутствует/);
  const saved=save_settings_export(f.state,{text:"{}"});
  assert.throws(()=>save_settings_export(f.state,{text:"x".repeat(2*1024*1024+1)}),/превышает/);
  assert.equal(fs.readFileSync(saved.path,"utf8"),"{}");
  fs.rmSync(saved.path);fs.mkdirSync(saved.path);
  assert.throws(()=>save_settings_export(f.state,{text:"{}"}));
  assert.equal(saved_settings_export(f.state),null);
  assert.deepEqual(fs.readdirSync(saved.directory),[saved.filename]);
});
