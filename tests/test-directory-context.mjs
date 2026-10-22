import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fixture, environment, session, node, success } from "./helpers.mjs";
import { dump, settings } from "../scripts/common.mjs";
import { locate_project, resolve, ProfileNotFound } from "../scripts/project_paths.mjs";
import { project_profile } from "../scripts/profile.mjs";
import { resolved_settings, instance_file } from "../scripts/project_context.mjs";
import { directory_context, edt_connection, edt_port_suggestion, edt_project_count, edt_project_descriptors, git_context } from "../scripts/directory_context.mjs";
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

test("nested profile selection remembers the user visit without writing project files or launching runtime", async t => {
  const f = fixture(t), child = path.join(f.root, "nested");
  dump(f.profile, path.join(child, ".ai/project.yaml"));
  const client = await session(t, "mcp/settings.mjs", [], f),
    view = (await client.call("settings.profile", {})).structuredContent;
  assert.equal(view.values.projectRoot, child);
  assert.equal(view.profile.path, path.join(child, ".ai/project.yaml"));
  assert.equal(view.directoryContext.directory, f.root);
  assert.deepEqual(fs.readdirSync(f.state).filter(name => name !== "diagnostics"), ["projects"]);
  assert.equal(view.profileHistory[0].projectRoot, child);
  assert.ok(view.profileHistory[0].lastOpened);
  assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);
  const context = success(node("hooks/session-start.mjs", [], { env: f.env, input: JSON.stringify({ cwd: f.root }) })).hookSpecificOutput.additionalContext;
  assert.match(context, /directoryContext/);
  assert.match(context, /"status":"loaded"/);
});

test("a new profile remains selectable and creatable beside EDT source trees exceeding the discovery limit", async t => {
  const f = fixture(t);environment(t, f.env);
  const application = path.join(f.root, "src"), framework = path.join(f.root, "test-framework");
  configuration(application, "Application");configuration(framework, "Framework");
  const sources = new Set([path.join(application, "src"), path.join(framework, "src")]);
  const entries = Array.from({ length: 20001 }, (_, index) => ({ name: `item-${index}`, isDirectory: () => true, isSymbolicLink: () => false }));
  const readdir = fs.readdirSync.bind(fs);let sourceReads = 0;
  t.mock.method(fs, "readdirSync", (directory, ...args) => {
    if (sources.has(String(directory))) { sourceReads++;return entries; }
    if (sources.has(path.dirname(String(directory)))) return [];
    return readdir(directory, ...args);
  });
  assert.throws(() => locate_project(f.root), ProfileNotFound);
  const backend = new SettingsBackend(), view = await backend.main({ action: "read" });
  assert.equal(view.values.projectRoot, f.root);assert.equal(view.profile.status, "missing");
  assert.equal(view.directoryContext.edt.projectCount, 2);
  assert.equal(fs.existsSync(path.join(f.root, ".ai")), false);assert.deepEqual(fs.readdirSync(f.state), []);
  const created = await backend.main({ action: "create" });
  assert.equal(created.values.projectRoot, f.root);assert.equal(created.profile.status, "loaded");
  assert.equal(fs.existsSync(path.join(f.root, ".ai/project.yaml")), true);
  assert.equal((await backend.main({ action: "read" })).profileHistory[0].projectRoot, f.root);
  assert.equal(sourceReads, 0);assert.equal(fs.existsSync(path.join(f.state, "runtime-lock.json")), false);
});

test("profile discovery ignores profiles inside EDT sources while finding nested project profiles", t => {
  const f = fixture(t), child = path.join(f.root, "extension");
  configuration(f.root);configuration(child, "Extension");
  dump(f.profile, path.join(f.root, "src/generated/.ai/project.yaml"));
  dump(f.profile, path.join(child, ".ai/project.yaml"));
  assert.equal(locate_project(f.root), child);
  assert.deepEqual(project_profile(f.root), f.profile);
  const other = path.join(f.root, "another");dump(f.profile, path.join(other, ".ai/project.yaml"));
  assert.throws(() => locate_project(f.root), /Multiple.*select a specific project/);
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

test("changed EDT preferences offer a local port update without writing the profile", async t => {
  const f=fixture(t);environment(t,f.env);f.profile.connections={edt:{url:"http://localhost:19801/custom/mcp"}};f.save();
  write(prefs(f.base),"mcpServerPort=19802");
  const backend=new SettingsBackend(),before=fs.readFileSync(path.join(f.root,".ai/project.yaml"));
  let view=await backend.main({action:"read"});assert.equal(view.values.edtUrl,"http://localhost:19801/custom/mcp");
  assert.equal(view.edtPortSuggestion.url,"http://localhost:19802/custom/mcp");
  assert.deepEqual(fs.readdirSync(f.state),[]);
  write(prefs(f.base),"mcpServerPort=19803");view=await backend.main({action:"status"});
  assert.equal(view.edtPortSuggestion.detectedPort,19803);
  await backend.main({action:"update",set:{edtUrl:view.edtPortSuggestion.url}});
  view=await backend.main({action:"read"});assert.equal(view.edtPortSuggestion,null);assert.equal(view.values.edtUrl,"http://localhost:19803/custom/mcp");
  assert.equal(view.connectionSources.edt,"instance");assert.deepEqual(fs.readFileSync(path.join(f.root,".ai/project.yaml")),before);
  assert.equal(fs.readFileSync(prefs(f.base),"utf8"),"mcpServerPort=19803");
  assert.equal(edt_port_suggestion("https://remote.example.test:19801/mcp",edt_connection(f.root)),null);
});

test("EDT counts use .project files independently of enrichment metadata and ignore generated state", t => {
  const f = fixture(t);
  assert.equal(edt_project_count(f.root), 0);
  write(path.join(f.root, ".project"), "<projectDescription><name>Base</name></projectDescription>");
  write(path.join(f.root, "extension/.project"), "<projectDescription><name>Extension</name></projectDescription>");
  for (const directory of [".git", ".metadata", "node_modules", ".build"])
    write(path.join(f.root, directory, "fixture/.project"), "ignored");
  assert.equal(edt_project_count(f.root), 2);
  assert.equal(directory_context(f.root).edt.projectCount, 2);
  assert.deepEqual(edt_project_descriptors(f.root).map(item=>item.name),["Base","Extension"]);
  assert.equal(edt_project_count(path.join(f.root, "absent")), null);
});

test("one shared Git repository contains two descriptor-backed EDT projects independent of profile repositories", t => {
  const f=fixture(t);git(f.root,"init","--initial-branch=main");
  const base=path.join(f.root,"configuration"),extension=path.join(f.root,"extension");
  write(path.join(base,".project"),"<projectDescription><!-- comment --><name>Base &amp; Shared</name></projectDescription>");
  write(path.join(extension,".project"),"<projectDescription><name>Extension</name><buildSpec><name>Wrong</name></buildSpec></projectDescription>");
  const context=directory_context(f.root);
  assert.equal(context.git.status,"detected");assert.equal(context.git.root,f.root);
  assert.equal(context.edt.projectCount,2);
  assert.deepEqual(context.edt.detectedProjects.map(item=>[item.name,item.directory]),[["Base & Shared",base],["Extension",extension]]);
  assert.equal(context.edt.projects.length,0); // No PMF is needed for the displayed inventory.
  fs.rmSync(path.join(extension,".project"));assert.equal(directory_context(f.root).edt.projectCount,1);
});

test("EDT inventory skips configuration sources while retaining nested extension projects", t => {
  const f=fixture(t);configuration(f.root,"Large configuration");
  const extension=path.join(f.root,"extension");configuration(extension,"Extension");
  const blocked=new Set([path.join(f.root,"src"),path.join(extension,"src")]);
  const readdir=fs.readdirSync.bind(fs);let sourceReads=0;
  t.mock.method(fs,"readdirSync",(directory,...args)=>{
    if(blocked.has(String(directory))){sourceReads++;throw new Error("Source tree must not be scanned for project descriptors");}
    return readdir(directory,...args);
  });
  const projects=edt_project_descriptors(f.root);
  assert.deepEqual(projects.map(project=>project.name),["Large configuration","Extension"]);
  assert.equal(edt_project_count(f.root),2);assert.equal(sourceReads,0);
});

test("profile inventory stays rooted at the canonical profile when the chat opens one EDT subproject", async t => {
  const f=fixture(t);f.save();git(f.root,"init","--initial-branch=main");
  const base=path.join(f.root,"configuration"),extension=path.join(f.root,"extension");
  configuration(base,"Base");configuration(extension,"Extension");
  f.env.EDT_AI_PROJECT_ROOT=base;
  const client=await session(t,"mcp/settings.mjs",[],f);
  const view=(await client.call("settings.profile",{})).structuredContent;
  assert.equal(view.values.projectRoot,f.root);assert.equal(view.directoryContext.directory,base);
  assert.equal(view.directoryContext.edt.projectCount,1);
  assert.equal(view.profileDirectoryContext.directory,f.root);
  assert.equal(view.profileDirectoryContext.edt.projectCount,2);
  assert.equal(view.profileDirectoryContext.git.root,f.root);
  assert.deepEqual(view.profileDirectoryContext.edt.detectedProjects.map(project=>project.name),["Base","Extension"]);
  assert.equal(view.profileHistory[0].edtProjectCount,2);
  const status=(await client.call("settings.status",{})).structuredContent;
  assert.equal(status.profileDirectoryContext.edt.projectCount,2);
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
