import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fixture, environment, session, node, success } from "./helpers.mjs";
import { dump, settings } from "../scripts/common.mjs";
import { locate_project, resolve } from "../scripts/project_paths.mjs";
import { project_profile } from "../scripts/profile.mjs";
import { resolved_settings, instance_file } from "../scripts/project_context.mjs";
import { directory_context, edt_connection, git_context } from "../scripts/directory_context.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";

const prefs = workspace => path.join(workspace, ".metadata/.plugins/org.eclipse.core.runtime/.settings/com.ditrix.edt.mcp.server.prefs");
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function configuration(root, name = "Product", version = "8.5.1") {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  write(path.join(root, ".project"), `<?xml version="1.0"?><projectDescription><!-- <name>Wrong</name> --><name>${name}</name><buildSpec><buildCommand><name>Builder</name></buildCommand></buildSpec></projectDescription>`);
  write(path.join(root, "DT-INF/PROJECT.PMF"), `Manifest-Version: 1.0\r\nRuntime-Version: ${version}\r\n`);
}
function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, shell: false });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
}

test("a unique nested canonical profile keeps its own relative paths and rejects ambiguity", async t => {
  const f = fixture(t), child = path.join(f.root, "nested", "product");
  fs.mkdirSync(path.join(f.root, ".git"));
  fs.mkdirSync(path.join(child, "src"), { recursive: true });
  dump(f.profile, path.join(child, ".ai/project.yaml"));
  for (const name of ["node_modules", ".metadata", ".work"])
    dump(f.profile, path.join(f.root, name, "copy/.ai/project.yaml"));
  assert.equal(locate_project(f.root), child);
  assert.deepEqual(project_profile(f.root), f.profile);
  const other = path.join(f.root, "another");
  dump(f.profile, path.join(other, ".ai/project.yaml"));
  assert.throws(() => locate_project(f.root), /Multiple.*select a specific project/);
  const refused = node("scripts/profile.mjs", ["init", f.root]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout, /Multiple/);
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);
  const client = await session(t, "mcp/settings.mjs", [], f), view = (await client.call("settings.profile", {})).structuredContent;
  assert.equal(view.profile.status, "ambiguous");
  assert.equal(view.profile.candidates.length, 2);
  assert.equal(view.directoryContext.directory, f.root);
  await assert.rejects(client.call("settings.create", {}), /Multiple/);
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);
});

test("nested profile selection works through settings and SessionStart without writes", async t => {
  const f = fixture(t), child = path.join(f.root, "nested");
  dump(f.profile, path.join(child, ".ai/project.yaml"));
  const client = await session(t, "mcp/settings.mjs", [], f),
    view = (await client.call("settings.profile", {})).structuredContent;
  assert.equal(view.values.projectRoot, child);
  assert.equal(view.profile.path, path.join(child, ".ai/project.yaml"));
  assert.equal(view.directoryContext.directory, f.root);
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);
  const context = success(node("hooks/session-start.mjs", [], { env: f.env, input: JSON.stringify({ cwd: f.root }) })).hookSpecificOutput.additionalContext;
  assert.match(context, /directoryContext/);
  assert.match(context, /"status":"loaded"/);
});

test("discovery does not follow a junction to another project's profile or EDT metadata", t => {
  const f = fixture(t), outside = path.join(f.base, "outside");
  configuration(outside);
  dump(f.profile, path.join(outside, ".ai/project.yaml"));
  fs.symlinkSync(outside, path.join(f.root, "linked"), "junction");
  assert.throws(() => locate_project(f.root), /No .ai/);
  assert.deepEqual(directory_context(f.root).edt.projects, []);
});

test("workspace prefs distinguish missing files, default ports, invalid ports and the nearest workspace", t => {
  const f = fixture(t);
  assert.equal(edt_connection(f.root).status, "workspace_not_found");
  write(prefs(f.base), "#mcpServerPort=1\r\nmcpServerPort = 19801\r\n");
  assert.equal(edt_connection(f.root).url, "http://127.0.0.1:19801/mcp");
  write(prefs(f.base), "eclipse.preferences.version=1\n");
  assert.equal(edt_connection(f.root).port, 8765);
  assert.equal(edt_connection(f.root).portSource, "default");
  for (const value of ["", "0", "65536", "8765.0", "bad"]){
    write(prefs(f.base), "mcpServerPort=" + value);
    assert.equal(edt_connection(f.root).status, "invalid_port");
    assert.equal(edt_connection(f.root).url, undefined);
  }
  write(prefs(f.base), "mcpServerPort=\n19801\n");
  assert.equal(edt_connection(f.root).status, "invalid_port");
  write(prefs(f.base), "mcpServerPort=19801");
  fs.mkdirSync(path.join(f.root, ".metadata"));
  assert.equal(edt_connection(f.root).status, "missing_preferences");
  assert.equal(edt_connection(f.root).url, undefined);
});

test("discovered ports refresh without writes and never override explicit or disabled connections", async t => {
  const f = fixture(t); environment(t, f.env); f.save();
  write(prefs(f.base), "mcpServerPort=19801");
  const config = settings(), backend = new SettingsBackend(f.state, f.env.EDT_AI_SETTINGS);
  let [effective, sources] = resolved_settings(config, f.root, f.profile);
  assert.equal(effective.mcp.required.edt.url, "http://127.0.0.1:19801/mcp");
  assert.equal(sources.edt, "edt_workspace");
  const exported = await backend.main({ action: "export" });
  assert.equal(JSON.parse(exported.text).profile.connections, undefined);
  const preview = await backend.main({ action: "preview", text: exported.text });
  write(prefs(f.base), "mcpServerPort=19802");
  await assert.rejects(backend.main({ action: "apply", text: exported.text, revision: preview.revision }), /измен/i);
  assert.equal((await backend.main({ action: "read" })).values.edtUrl, "http://127.0.0.1:19802/mcp");
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
  f.profile.connections = { edt: { url: "https://edt.example.test/mcp" } };
  assert.equal(resolved_settings(config, f.root, f.profile)[0].mcp.required.edt.url, f.profile.connections.edt.url);
  dump({ connections: { edt: { url: "" } } }, instance_file(config, f.root));
  assert.equal(resolved_settings(config, f.root, f.profile)[0].mcp.required.edt.url, "");
  process.env.EDT_AI_EDT_URL = "http://localhost:19803/mcp";
  assert.equal(resolved_settings(config, f.root, f.profile)[0].mcp.required.edt.url, process.env.EDT_AI_EDT_URL);
});

test("EDT descriptors enrich the selected directory, without assuming folder names or reading sources", async t => {
  const f = fixture(t), first = path.join(f.root, "configuration"), second = path.join(f.root, "extension");
  configuration(first, "Base &amp; Library");
  configuration(second, "Расширение", "8.3.27");
  fs.mkdirSync(path.join(first, ".settings"));
  // A builder name without a project name is not an EDT project identity.
  configuration(path.join(f.root, "incomplete"));
  fs.unlinkSync(path.join(f.root, "incomplete/DT-INF/PROJECT.PMF"));
  write(path.join(first, "src/source.bsl"), "source contents are irrelevant");
  write(prefs(f.base), "mcpServerPort=19801");
  const before = fs.readFileSync(path.join(first, ".project")),
    context = directory_context(f.root);
  assert.deepEqual(context.edt.projects.map(item => [item.name, item.runtimeVersion]), [["Base & Library", "8.5.1"], ["Расширение", "8.3.27"]]);
  assert.equal(context.edt.projects[0].source, path.join(first, "src"));
  assert.equal(context.edt.projects[0].settingsDirectory, path.join(first, ".settings"));
  assert.equal(context.edt.projects[1].settingsDirectory, null);
  assert.equal(context.edt.connection.liveVerified, false);
  const client = await session(t, "mcp/settings.mjs", [], f),
    view = (await client.call("settings.profile", {})).structuredContent;
  assert.equal(view.profile.status, "missing");
  assert.deepEqual(view.directoryContext, context);
  const hook = success(node("hooks/session-start.mjs", [], { env: f.env, input: JSON.stringify({ cwd: f.root }) })).hookSpecificOutput.additionalContext;
  assert.match(hook, /Base & Library/);
  assert.match(hook, /8\.5\.1/);
  assert.deepEqual(fs.readFileSync(path.join(first, ".project")), before);
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), []);
});

test("Git context handles unborn, detached and linked worktrees and ignores inherited Git selection", t => {
  const f = fixture(t); environment(t, f.env);
  assert.equal(git_context(f.root).status, "not_repository");
  git(f.root, "init", "--initial-branch=topic");
  assert.equal(git_context(f.root).branch, "topic");
  assert.equal(git_context(f.root).commit, null);
  git(f.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
  const commit = git(f.root, "rev-parse", "HEAD"), linked = path.join(f.base, "linked");
  git(f.root, "worktree", "add", "--detach", linked, "HEAD");
  process.env.GIT_DIR = path.join(f.base, "unrelated");
  process.env.GIT_WORK_TREE = f.base;
  const context = git_context(linked);
  assert.equal(resolve(context.root), linked);
  assert.equal(context.branch, null);
  assert.equal(context.detached, true);
  assert.equal(context.commit, commit);
  assert.equal(git_context(f.root).branch, "topic");
  // Context reports no credentials or remote URLs.
  assert.deepEqual(Object.keys(context).sort(), ["branch", "commit", "detached", "gitDirectory", "root", "status"]);
});
