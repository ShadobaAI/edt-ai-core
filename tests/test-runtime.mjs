import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { edt_fixture as fixture, environment, ROOT, node, success } from "./helpers.mjs";
import { settings, sleep, operation_lock } from "../scripts/common.mjs";
import {
  platform_build,
  ensure_installed,
  latest_version,
  list_versions,
  artifact,
  sha,
  save_json,
  read_json,
  validate_bsl_tools,
  index_config,
  index_readiness,
  index_status,
  rebuild_index,
  rebuild_all_indexes,
  restart_index,
  acquire_reader,
  path_key,
  ensure_daemon,
  start_daemon,
  daemon_health,
  fetch_json,
  stop_daemon,
  project_home,
} from "../scripts/runtime.mjs";
import { sha256 } from "../scripts/project_paths.mjs";
import { zip, unzip, extract_binary } from "../scripts/archives.mjs";
import { launch, spawn_guarded_linux, stop_child, alive } from "../scripts/processes.mjs";
import { inspect } from "../scripts/doctor.mjs";
import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { once } from "node:events";
import { native_environment } from "../scripts/components.mjs";
import { LOG_POLICY, read_diagnostic_logs } from "../scripts/diagnostics.mjs";

test("release metadata is bounded and failed HTTP bodies are cancelled", async t => {
  for (const status of [200, 503]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { if (status === 200) controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    });
    t.mock.method(globalThis, "fetch", async () => new Response(body, { status }));
    await assert.rejects(fetch_json("https://catalog.invalid/releases"), status === 200 ? /8 МиБ/ : /HTTP 503/);
    assert.equal(cancelled, true);
    t.mock.restoreAll();
  }
});

test("BSL release selection prefers a supported stable release and falls back to the latest supported RC", async () => {
  let stable = { tag_name: "v1.0.7", prerelease: false };
  const releases = [
    { tag_name: "v1.1.0-rc.9", draft: true, prerelease: true },
    { tag_name: "v1.1.0-rc.8", prerelease: true },
    { tag_name: "v1.1.0-rc.3", prerelease: true },
    stable,
  ];
  const io = { fetch_json: async url => url.endsWith("/latest") ? stable : releases };
  assert.equal(await latest_version("bsl-ls", io), "v1.1.0-rc.8");
  assert.deepEqual((await list_versions("bsl-ls", io)).versions.map(item => item.version), ["v1.1.0-rc.8"]);
  stable = { tag_name: "v1.1.0", prerelease: false };
  assert.equal(await latest_version("bsl-ls", io), "v1.1.0");
  assert.equal(await latest_version("bsl-ls", io, { allowPrerelease: true }), "v1.1.0-rc.8");
  const missingStable = { fetch_json: async url => { if (url.endsWith("/latest")) throw Object.assign(new Error("fixture release unavailable"), { status: 404 }); return releases; } };
  assert.equal(await latest_version("bsl-ls", missingStable), "v1.1.0-rc.8");
});

test("BSL rejects an explicitly selected old release before contacting GitHub", async t => {
  const f = fixture(t), config = settings();
  for (const version of ["v1.0.7", "v1.1.0-rc.3", "unknown"]) {
    config.mcp.managed["bsl-ls"].version = version;
    await assert.rejects(ensure_installed(f.state, config, "bsl-ls", false, { fetch_json: async () => { throw new Error("unexpected request"); } }), /1\.1\.0-rc\.4/);
  }
});

for (const [platform, arch, expected] of [
  ["win32", "x64", "windows-x64.zip"],
  ["linux", "x64", "linux-x64.tar.gz"],
  ["darwin", "arm64", "macos-arm64.tar.gz"],
])
  test(`select code-index ${platform}/${arch}`, () =>
    assert.ok(platform_build(platform, arch).asset.endsWith(expected)));
for (const [platform, arch] of [
  ["win32", "arm64"],
  ["linux", "arm64"],
  ["darwin", "x64"],
  ["freebsd", "x64"],
  ["linux", "ia32"],
])
  test(`unsupported ${platform}/${arch} has actionable error`, () =>
    assert.throws(
      () => platform_build(platform, arch),
      /Неподдерживаемая платформа code-index.*Доступны сборки/,
    ));
function ioFor(bytes, digest = sha256(bytes)) {
  return {
    fetch_json: async () => ({
      tag_name: "v1.2.3",
      assets: [
        {
          name: "bsl-language-server-1.2.3-exec.jar",
          size: bytes.length,
          digest: "sha256:" + digest,
          browser_download_url:
            "https://github.com/1c-syntax/bsl-language-server/releases/download/v1.2.3/server.jar",
        },
      ],
    }),
    fetch: async () => new Response(bytes),
  };
}
test("verified downloads are immutable and corrupt artifacts are never installed", async (t) => {
  const f = fixture(t),
    config = settings(),
    firstBytes = zip({ "META-INF/MANIFEST.MF": Buffer.from("old") });
  const first = await ensure_installed(
    f.state,
    config,
    "bsl-ls",
    false,
    ioFor(firstBytes),
  );
  assert.equal(artifact(f.state, "bsl-ls"), first);
  const firstHash = sha(first);
  const second = await ensure_installed(
    f.state,
    config,
    "bsl-ls",
    true,
    ioFor(zip({ "META-INF/MANIFEST.MF": Buffer.from("new") })),
  );
  assert.notEqual(first, second);
  assert.equal(artifact(f.state, "bsl-ls"), first);
  assert.equal(artifact(f.state, "bsl-ls", "candidate"), second);
  assert.equal(sha(first), firstHash);
  const unchanged = await ensure_installed(
    f.state,
    config,
    "bsl-ls",
    true,
    ioFor(fs.readFileSync(second)),
  );
  assert.equal(unchanged, second);
  fs.writeFileSync(second, "corrupt");
  assert.equal(artifact(f.state, "bsl-ls", "candidate"), null);
  assert.equal(artifact(f.state, "bsl-ls"), first);
});
for (const kind of [
  "digest",
  "size",
  "missing digest",
  "bad tag",
  "draft",
  "prerelease",
  "wrong source",
  "invalid jar",
])
  test("reject untrusted download: " + kind, async (t) => {
    const f = fixture(t),
      bytes =
        kind === "invalid jar"
          ? Buffer.from("not a jar")
          : zip({ "a.txt": Buffer.from("x") }),
      io = ioFor(bytes),
      release = await io.fetch_json();
    if (kind === "digest")
      release.assets[0].digest = "sha256:" + "0".repeat(64);
    if (kind === "size") release.assets[0].size++;
    if (kind === "missing digest") delete release.assets[0].digest;
    if (kind === "bad tag") release.tag_name = "../outside";
    if (kind === "draft") release.draft = true;
    if (kind === "prerelease") release.prerelease = true;
    if (kind === "wrong source")
      release.assets[0].browser_download_url = "https://example.com/a.jar";
    io.fetch_json = async () => release;
    await assert.rejects(
      ensure_installed(f.state, settings(), "bsl-ls", false, io),
    );
    assert.ok(!fs.existsSync(path.join(f.state, "runtime-lock.json")));
  });
test("runtime lock cannot redirect to another component or outside state", (t) => {
  const f = fixture(t);
  for (const relative of [
    "../foreign.jar",
    "runtime/code-index/v1.2.3/bsl-language-server-exec.jar",
  ]) {
    save_json(path.join(f.state, "runtime-lock.json"), {
      "bsl-ls": { release: "v1.2.3", sha256: "0".repeat(64), path: relative },
    });
    assert.throws(() => artifact(f.state, "bsl-ls"));
  }
});
test("ZIP binary extraction accepts only one regular known executable", () => {
  assert.equal(
    Buffer.from(
      extract_binary(
        zip({ "folder/bsl-indexer.exe": Buffer.from("binary") }),
        "zip",
        "bsl-indexer.exe",
      ),
    ).toString(),
    "binary",
  );
  assert.throws(
    () =>
      extract_binary(
        zip({
          "a/bsl-indexer.exe": Buffer.from("a"),
          "b/bsl-indexer.exe": Buffer.from("b"),
        }),
        "zip",
        "bsl-indexer.exe",
      ),
    /Архив должен содержать ровно один файл /,
  );
  assert.throws(
    () =>
      extract_binary(
        zip({ "../bsl-indexer.exe": Buffer.from("a") }),
        "zip",
        "bsl-indexer.exe",
      ),
    /Небезопасная запись ZIP/,
  );
});
test("ZIP decoding uses the validated directory despite signatures in comments and rejects ZIP64", () => {
  const original = Buffer.from(zip({ "bsl-indexer.exe": Buffer.from("binary") }));
  const end = original.length - 22;
  const fakeEnd = Buffer.alloc(22);
  fakeEnd.writeUInt32LE(0x06054b50);
  fakeEnd.writeUInt16LE(1, 20);
  const commented = Buffer.concat([original, fakeEnd]);
  commented.writeUInt16LE(fakeEnd.length, end + 20);
  assert.equal(Buffer.from(unzip(commented)["bsl-indexer.exe"]).toString(), "binary");

  const directory = original.readUInt32LE(end + 16);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50);
  const zip64 = Buffer.concat([original.subarray(0, end), locator, original.subarray(end)]);
  zip64.writeUInt16LE(locator.length, directory + 32);
  zip64.writeUInt32LE(original.readUInt32LE(end + 12) + locator.length, end + locator.length + 12);
  assert.throws(() => unzip(zip64), /ZIP64 не поддерживается/);

  const normalComment = Buffer.concat([original, Buffer.from("release")]);
  normalComment.writeUInt16LE(7, end + 20);
  assert.equal(Buffer.from(unzip(normalComment)["bsl-indexer.exe"]).toString(), "binary");
});

test("ZIP inflation enforces the declared output size while decompressing", () => {
  for (const claimedSize of [0, 1]) {
    const bytes = Buffer.from(zip({ "payload.txt": Buffer.alloc(64 * 1024, 65) }));
    const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(claimedSize, directory + 24);
    bytes.writeUInt32LE(claimedSize, 22);
    assert.throws(() => unzip(bytes), error => error.code === "ARCHIVE_SIZE_LIMIT");
  }
  assert.equal(unzip(zip({ empty: Buffer.alloc(0) })).empty.length, 0);
});

test("ZIP entries cannot redirect the decoder through contradictory local headers", () => {
  for (const change of [
    (bytes, directory) => bytes.writeUInt32LE(directory, directory + 42),
    bytes => bytes.writeUInt16LE(0, 8),
    bytes => { bytes[30] ^= 1; },
    (bytes, directory) => bytes.writeUInt32LE(bytes.length, directory + 20),
  ]) {
    const bytes = Buffer.from(zip({ "payload.txt": Buffer.from("bounded contents") }));
    const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    change(bytes, directory);
    assert.throws(() => unzip(bytes), /ZIP/);
  }
});
test("tar.gz binary extraction checks checksum and refuses links or duplicate executables", () => {
  const make = (type = "0") => {
    const header = Buffer.alloc(512);
    header.write("bsl-indexer");
    header.write("00000000006\0", 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(
      [...header]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    );
    return Buffer.concat([
      header,
      Buffer.from("binary"),
      Buffer.alloc(506),
      Buffer.alloc(1024),
    ]);
  };
  assert.equal(
    extract_binary(gzipSync(make()), "tar.gz", "bsl-indexer").toString(),
    "binary",
  );
  assert.throws(
    () => extract_binary(gzipSync(make("2")), "tar.gz", "bsl-indexer"),
    /Исполняемый файл компонента должен быть обычным файлом/,
  );
  const bad = make();
  bad[0]++;
  assert.throws(
    () => extract_binary(gzipSync(bad), "tar.gz", "bsl-indexer"),
    /контрольная сумма/,
  );
});
test("BSL capability gate accepts live analyzer names and requires native lifecycle and scoping", () => {
  const lifecycle = [
      "register_workspace_folder",
      "list_workspace_folders",
      "unregister_workspace_folder",
    ].map((name) => ({ name })),
    analyzer = {
      name: "new_analyzer",
      inputSchema: {
        type: "object",
        properties: { workspaceFolder: { type: "string" } },
        required: ["workspaceFolder"],
      },
    };
  assert.throws(() => validate_bsl_tools(lifecycle), /workspaceFolder/);
  validate_bsl_tools([...lifecycle, analyzer]);
  assert.throws(
    () => validate_bsl_tools([analyzer]),
    /register_workspace_folder/,
  );
});
test("index readiness needs exact aliases, paths and positive freshness, including verbatim Windows paths", (t) => {
  const f = fixture(t),
    body = {
      mcp: { status: "ok" },
      daemon: { status: "online" },
      repos: [
        {
          repo: "product",
          root_path: f.root,
          path_status: { status: "ready" },
          data_version: { stale: false },
        },
      ],
    };
  assert.equal(index_readiness(body, f.root, f.profile), true);
  for (const change of [
    (x) => (x.repos[0].repo = "other"),
    (x) => (x.repos[0].root_path = f.base),
    (x) => (x.repos[0].data_version = {}),
    (x) => (x.repos[0].data_version.stale = true),
    (x) => (x.repos[0].path_status.error = "failed"),
    (x) => x.repos.push(x.repos[0]),
  ]) {
    const bad = structuredClone(body);
    change(bad);
    assert.equal(index_readiness(bad, f.root, f.profile), false);
  }
  if (process.platform === "win32")
    assert.equal(path_key("\\\\?\\" + f.root), path_key(f.root));
});
test("index status distinguishes existing ready data, active indexing, stale data and errors", t => {
  const f=fixture(t), body={mcp:{status:"ok"},daemon:{status:"online"},repos:[{repo:"product",root_path:f.root,path_status:{status:"ready"},data_version:{stale:false}}]};
  fs.mkdirSync(path.join(f.root,".code-index"));fs.writeFileSync(path.join(f.root,".code-index/index.db"),"existing");
  assert.equal(index_status(body,f.root,f.profile).state,"ready");
  assert.equal(index_status(body,f.root,f.profile).repositories[0].present,true);
  for(const [status,stale,expected] of [["indexing",false,"indexing"],["initial_indexing",false,"indexing"],["reindexing_batch",false,"indexing"],["reindexing_extras",false,"indexing"],["ready",true,"stale"],["error",false,"error"],["unknown",undefined,"not_checked"]]){
    const changed=structuredClone(body);changed.repos[0].path_status.status=status;changed.repos[0].data_version.stale=stale;
    assert.equal(index_status(changed,f.root,f.profile).state,expected);
  }
  const settling=structuredClone(body);settling.repos[0].data_version={};
  assert.equal(index_status(settling,f.root,f.profile).ready,false);
  assert.equal(index_status(settling,f.root,f.profile).retryable,true);
  for(const change of [x=>x.daemon.status="offline",x=>x.mcp.status="error",x=>x.repos.push(x.repos[0])]){
    const invalid=structuredClone(settling);change(invalid);assert.notEqual(index_status(invalid,f.root,f.profile).retryable,true);
  }
  fs.rmSync(path.join(f.root,".code-index/index.db"));body.repos[0].path_status.status="unknown";
  assert.equal(index_status(body,f.root,f.profile).state,"missing");
  assert.notEqual(index_status(body,f.root,f.profile).retryable,true);
  body.repos[0].root_path=f.base;assert.equal(index_status(body,f.root,f.profile).state,"mismatch");
});

test("index selects repositories with matching nested EDT descriptors and ignores feature-only repositories", async t => {
  const f=fixture(t), ui=path.join(f.root,"ui"), framework=path.join(f.root,"framework"), nested=path.join(framework,"exts/Core");
  fs.mkdirSync(ui); fs.mkdirSync(nested,{recursive:true});
  fs.writeFileSync(path.join(nested,".project"),"<projectDescription><name>Different.Internal.Name</name></projectDescription>");
  f.profile.repositories.push({id:"ui",path:"ui",alias:"ui"},{id:"framework",path:"framework",alias:"framework",edt_project:"Core"});
  f.profile.policy.unbound_edt_repositories=["ui"];
  const home=path.join(f.base,"index-home");fs.mkdirSync(home);
  index_config(home,f.root,f.profile);
  const config=fs.readFileSync(path.join(home,"daemon.toml"),"utf8");
  assert.match(config,/alias = "framework"/);assert.doesNotMatch(config,/alias = "ui"/);
  const body={mcp:{status:"ok"},daemon:{status:"online"},repos:[
    {repo:"product",root_path:f.root,path_status:{status:"ready"},data_version:{stale:false}},
    {repo:"framework",root_path:framework,path_status:{status:"ready"},data_version:{stale:false}}]};
  assert.equal(index_status(body,f.root,f.profile).state,"ready");
  assert.deepEqual(index_status(body,f.root,f.profile).repositories.map(item=>item.id),["product","framework"]);
  fs.writeFileSync(path.join(nested,".project"),"<projectDescription><name></name></projectDescription>");
  assert.equal(index_status(body,f.root,f.profile).state,"ready");
  await assert.rejects(rebuild_index(f.state,settings(),f.root,f.profile,"ui"),/EDT-проект/);
  const duplicate=path.join(framework,"other/Core");fs.mkdirSync(duplicate,{recursive:true});
  fs.writeFileSync(path.join(duplicate,".project"),"<projectDescription><name>Another</name></projectDescription>");
  assert.equal(index_status(body,f.root,f.profile).state,"missing_project");
  fs.rmSync(path.join(duplicate,".project"));
  f.profile.repositories.find(repo=>repo.id==="framework").edt_project="Different.Internal.Name";
  assert.equal(index_status(body,f.root,f.profile).state,"missing_project");
  f.profile.repositories.find(repo=>repo.id==="framework").edt_project="Core";
  fs.rmSync(path.join(nested,".project"));
  assert.equal(index_status(body,f.root,f.profile).state,"missing_project");
  assert.deepEqual(index_status(body,f.root,f.profile).missingProjects,["framework"]);
  fs.writeFileSync(path.join(nested,".project"),"<projectDescription><name>Core</name>");
  assert.equal(index_status(body,f.root,f.profile).state,"missing_project");
});

test("applying index mappings waits for readers and restarts without rebuilding", async t => {
  const f=fixture(t), calls=[], config=settings();
  const io={installed:async()=>"fixture-exe",stop:async()=>calls.push("stop"),run:async()=>assert.fail("must not rebuild"),restart:async()=>calls.push("restart"),smoke:async()=>({index_ready:true})};
  const lease=await acquire_reader(f.state,f.root);
  await assert.rejects(restart_index(f.state,config,f.root,f.profile,io),/Завершите текущие запросы/);
  assert.deepEqual(calls,[]);await lease.close();
  assert.equal((await restart_index(f.state,config,f.root,f.profile,io)).state,"ready");
  assert.deepEqual(calls,["stop","restart"]);
});

test("applying changed mappings replaces the owned live daemon without rebuilding", async t => {
  const f=fixture(t), digest=sha256(fs.readFileSync(process.execPath)), exe=path.join(f.state,"runtime/code-index/fixture",digest,"node.exe"), children=[];
  fs.mkdirSync(path.dirname(exe),{recursive:true});fs.copyFileSync(process.execPath,exe);
  const launchIo={launch:(command,args,options)=>{
    const child=launch(command,[path.join(ROOT,"tests/fixtures/index-daemon.mjs")],options);
    children.push(child);f.clients.push({close:()=>stop_child(child,0)});return child;
  }};
  const home=await ensure_daemon(f.state,f.root,f.profile,exe,launchIo), old=(await daemon_health(home)).pid;
  fs.mkdirSync(path.join(f.root,"extension"));
  fs.writeFileSync(path.join(f.root,"extension/.project"),"<projectDescription><name>Extension</name></projectDescription>");
  f.profile.repositories.push({id:"extension",path:"extension",alias:"extension",edt_project:"extension"});
  const result=await restart_index(f.state,settings(),f.root,f.profile,{
    installed:async()=>exe,
    stop:(state,root)=>stop_daemon(state,root,{stop:async()=>stop_child(children[0],0)}),
    restart:(state,root,data,binary)=>ensure_daemon(state,root,data,binary,launchIo),
    run:async()=>assert.fail("must not rebuild"),smoke:async()=>({index_ready:true}),
  });
  assert.equal(result.state,"ready");assert.notEqual((await daemon_health(home)).pid,old);
  assert.match(fs.readFileSync(path.join(home,"daemon.toml"),"utf8"),/alias = "extension"/);
});

test("a .project link to another repository cannot make feature files indexable", t => {
  const f=fixture(t), ui=path.join(f.root,"ui");fs.mkdirSync(ui);
  try { fs.symlinkSync(path.join(f.root,".project"),path.join(ui,".project"),"file"); }
  catch (error) { if (["EPERM","EACCES","ENOTSUP"].includes(error.code)) return t.skip("file symlinks unavailable"); throw error; }
  f.profile.repositories.push({id:"ui",path:"ui",alias:"ui"});
  const home=path.join(f.base,"index-home");fs.mkdirSync(home);index_config(home,f.root,f.profile);
  assert.doesNotMatch(fs.readFileSync(path.join(home,"daemon.toml"),"utf8"),/alias = "ui"/);
});

test("index rebuild targets exactly one repository and restores the owned service", async t => {
  const f=fixture(t), config=settings(), calls=[];
  f.profile.repositories.push({id:"extension",path:"extension",alias:"extension",edt_project:"extension"});f.save();
  fs.mkdirSync(path.join(f.root,"extension"));
  fs.writeFileSync(path.join(f.root,"extension/.project"),"<projectDescription><name>Extension</name></projectDescription>");
  const before=fs.readFileSync(path.join(f.root,".ai/project.yaml")), home=path.join(project_home(f.state,f.root),"code-index");
  const io={installed:async()=>"fixture-exe",stop:async()=>calls.push("stop"),run:async(exe,directory)=>{assert.equal(exe,"fixture-exe");assert.equal(directory,path.join(f.root,"extension"));calls.push("run");},restart:async()=>calls.push("restart"),smoke:async()=>({index_ready:true,index_state:"ready"})};
  const result=await rebuild_index(f.state,config,f.root,f.profile,"extension",io);
  assert.equal(result.repository,"extension");assert.equal(result.state,"ready");assert.deepEqual(calls,["stop","run","restart"]);
  assert.deepEqual(fs.readFileSync(path.join(f.root,".ai/project.yaml")),before);assert.equal(fs.existsSync(path.join(home,"maintenance.json")),false);
  await assert.rejects(rebuild_index(f.state,config,f.root,f.profile,"foreign",io),/EDT-проект/);
  calls.length=0;
  await assert.rejects(rebuild_index(f.state,config,f.root,f.profile,"extension",{...io,run:async()=>{throw new Error("index failed");}}),/index failed/);
  assert.deepEqual(calls,["stop","restart"]);assert.equal(fs.existsSync(path.join(home,"maintenance.json")),false);
  await assert.rejects(rebuild_index(f.state,config,f.root,f.profile,"extension",{...io,stop:async()=>{throw new Error("unknown stop");}}),error=>error.outcomeUnknown===true);
  assert.equal(fs.existsSync(path.join(home,"maintenance.json")),true);
  await assert.rejects(rebuild_index(f.state,config,f.root,f.profile,"extension",{...io,stop:async()=>assert.fail("must not retry an uncertain stop")}),/прервано/);
});

test("rebuilding all indexes reports each EDT project while holding one maintenance window", async t => {
  const f = fixture(t), calls = [], progress = [];
  for (const [id, edt] of [["extension", true], ["features", false]]) {
    fs.mkdirSync(path.join(f.root, id));
    if (edt) fs.writeFileSync(path.join(f.root, id, ".project"), "<projectDescription><name>Extension</name></projectDescription>");
    f.profile.repositories.push({ id, path: id, alias: id, ...(edt ? { edt_project: id } : {}) });
  }
  f.save(); const before = fs.readFileSync(path.join(f.root, ".ai/project.yaml"));
  let release, entered;
  const gate = new Promise(done => { release = done; }), started = new Promise(done => { entered = done; });
  const rebuilding = rebuild_all_indexes(f.state, settings(), f.root, f.profile, {
    installed: async () => "fixture-exe", stop: async () => calls.push("stop"),
    run: async (_exe, directory) => { calls.push(directory); if (directory === f.root) { entered(); await gate; } },
    restart: async () => calls.push("restart"), smoke: async () => ({ index_ready: true }), progress: item => progress.push(item),
  });
  await started;
  try {
    assert.deepEqual(calls, ["stop", f.root]);
    assert.deepEqual(progress.at(-1), { phase: "indexing", total: 2, completed: 0, repository: "product", edtProject: "Product" });
    assert.equal(fs.existsSync(path.join(project_home(f.state, f.root), "code-index/maintenance.json")), true);
  } finally { release(); await rebuilding; }
  const result = await rebuilding;
  assert.deepEqual(calls, ["stop", f.root, path.join(f.root, "extension"), "restart"]);
  assert.equal(result.all, true); assert.equal(result.state, "ready");
  assert.deepEqual(result.rebuilt.map(item => item.repository), ["product", "extension"]);
  assert.deepEqual(progress.filter(item => item.phase === "indexing").map(item => [item.repository, item.completed]), [["product", 0], ["extension", 1]]);
  assert.deepEqual(progress.at(-1), { phase: "checking", total: 2, completed: 2 });
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".ai/project.yaml")), before);
  assert.equal(fs.existsSync(path.join(project_home(f.state, f.root), "code-index/maintenance.json")), false);
});

test("a failed bulk rebuild retains partial progress and restores the service before returning an error", async t => {
  const f = fixture(t), calls = [], progress = [];
  for (const id of ["extension", "later"]) {
    fs.mkdirSync(path.join(f.root, id)); fs.writeFileSync(path.join(f.root, id, ".project"), `<projectDescription><name>${id}</name></projectDescription>`);
    f.profile.repositories.push({ id, path: id, alias: id, edt_project: id });
  }
  await assert.rejects(rebuild_all_indexes(f.state, settings(), f.root, f.profile, {
    installed: async () => "fixture-exe", stop: async () => calls.push("stop"),
    run: async (_exe, directory) => { calls.push(directory); if (directory.endsWith("extension")) throw new Error("failed extension"); },
    restart: async () => calls.push("restart"), smoke: async () => assert.fail("failed rebuild cannot pass smoke"), progress: item => progress.push(item),
  }), /failed extension/);
  assert.deepEqual(calls, ["stop", f.root, path.join(f.root, "extension"), "restart"]);
  assert.deepEqual(progress.at(-1), { phase: "restoring", total: 3, completed: 1, repository: "extension", edtProject: "extension" });
  assert.equal(fs.existsSync(path.join(project_home(f.state, f.root), "code-index/maintenance.json")), false);
});

test("daemon launch leaves logging to the component without duplicate output files", async t => {
  const f = fixture(t), home = path.join(f.base, "daemon");
  fs.mkdirSync(home);
  await assert.rejects(start_daemon(home, f.root, f.profile, process.execPath, { launch: (_exe, args, options) => {
    assert.deepEqual(args, ["daemon", "run"]);
    assert.equal(options.stdio, "ignore");
    assert.equal(options.sessionOwned, false);
    assert.equal(options.env.CODE_INDEX_HOME, home);
    throw new Error("fixture launcher stopped");
  } }), /fixture launcher stopped/);
  for (const name of ["stdout.log", "stderr.log", "rebuild.log"])
    assert.equal(fs.existsSync(path.join(home, name)), false);
});

test("a noisy failed rebuild uses bounded diagnostics and restores its service without a separate log", async t => {
  const f = fixture(t), calls = [];
  fs.writeFileSync(path.join(f.root, "index"), `process.stderr.write('Picked up JAVA_TOOL_OPTIONS: -Dsession.passphrase=diagnostic-secret-fixture\\n'); const chunk=Buffer.alloc(65536,'x');
    for(let i=0;i<128;i++) { process.stdout.write(chunk); process.stderr.write(chunk); }
    process.exitCode=3;`);
  await assert.rejects(rebuild_index(f.state, settings(), f.root, f.profile, "product", {
    installed: async () => process.execPath, stop: async () => calls.push("stop"),
    restart: async () => calls.push("restart"), smoke: async () => assert.fail("failed rebuild cannot pass smoke"),
  }), /журнал поддержки.*код 3/);
  assert.deepEqual(calls, ["stop", "restart"]);
  const home = path.join(project_home(f.state, f.root), "code-index");
  for (const name of ["rebuild.log", "stdout.log", "stderr.log", "maintenance.json"])
    assert.equal(fs.existsSync(path.join(home, name)), false);
  const files = fs.readdirSync(path.join(f.state, "diagnostics")).filter(name => name.endsWith(".jsonl"));
  assert.ok(files.length > 0 && files.length <= LOG_POLICY.files);
  for (const name of files) {
    const file = path.join(f.state, "diagnostics", name);
    assert.ok(fs.statSync(file).size <= LOG_POLICY.fileBytes);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /diagnostic-secret-fixture/);
  }
  const events = read_diagnostic_logs(f.state).events;
  const output = events.filter(event => event.component === "code-index" && event.event === "index_output");
  assert.equal(output.length, 1); assert.equal(output[0].level, "info"); assert.ok(output[0].detail.bytes > 1024);
  assert.ok(events.some(event => event.event === "index_failed" && event.level === "error" && event.detail.exitCode === 3));
});

test("an unconfirmed index writer retains maintenance and cannot restart the daemon over that writer", async t => {
  const f = fixture(t), calls = [];
  await assert.rejects(rebuild_index(f.state, settings(), f.root, f.profile, "product", {
    installed: async () => "fixture-exe", stop: async () => calls.push("stop"),
    run: async () => { calls.push("run"); throw Object.assign(new Error("writer termination unknown"), { outcomeUnknown: true }); },
    restart: async () => assert.fail("must not start a competing writer"),
  }), error => error.outcomeUnknown === true);
  assert.deepEqual(calls, ["stop", "run"]);
  const marker = path.join(project_home(f.state, f.root), "code-index/maintenance.json"), before = fs.readFileSync(marker);
  await assert.rejects(acquire_reader(f.state, f.root), /прервано/);
  assert.deepEqual(fs.readFileSync(marker), before);
});

test("an unconfirmed daemon startup blocks later sessions, including launch failures before a controller is returned", async t => {
  for (const phase of ["launch", "rollback"]) {
    const f = fixture(t), home = path.join(project_home(f.state, f.root), "code-index"); let launches = 0;
    const io = { launch: () => {
      launches++;
      if (phase === "launch") throw Object.assign(new Error("launch outcome unknown"), { outcomeUnknown: true });
      return { pid: process.pid, exitCode: 1, signalCode: null, once() {}, unref() {},
        rollback: async () => { throw new Error("rollback was not confirmed"); }, release() {} };
    } };
    await assert.rejects(ensure_daemon(f.state, f.root, f.profile, process.execPath, io), error => error.outcomeUnknown === true);
    const marker = path.join(home, "maintenance.json"), before = fs.readFileSync(marker);
    assert.equal(JSON.parse(before).reason, "daemon_start_cleanup_unknown");
    assert.equal(fs.existsSync(path.join(home, "operation.lock")), false);
    await assert.rejects(ensure_daemon(f.state, f.root, f.profile, process.execPath, io), error => error.message.includes(marker));
    assert.equal(launches, 1); assert.deepEqual(fs.readFileSync(marker), before);
  }
});

test("an unwritable daemon cleanup barrier retains the project lock", async t => {
  const f = fixture(t), home = path.join(project_home(f.state, f.root), "code-index"), marker = path.join(home, "maintenance.json");
  const link = fs.linkSync;
  t.mock.method(fs, "linkSync", (source, destination) => {
    if (destination === marker) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return link(source, destination);
  });
  await assert.rejects(ensure_daemon(f.state, f.root, f.profile, process.execPath, { launch: () => {
    throw Object.assign(new Error("launch outcome unknown"), { outcomeUnknown: true });
  } }), error => error.outcomeUnknown === true && error.message.includes(path.join(home, "operation.lock")));
  const lock = path.join(home, "operation.lock"); assert.equal(fs.existsSync(lock), true);
  await assert.rejects(operation_lock(home, () => assert.fail("must stay blocked")), error => error.code === "RUNTIME_BUSY" && error.message.includes(lock));
});

test("a vanished cleanup marker after EEXIST retains the project lock", async t => {
  const f = fixture(t), home = path.join(project_home(f.state, f.root), "code-index"), marker = path.join(home, "maintenance.json");
  const link = fs.linkSync;
  t.mock.method(fs, "linkSync", (source, destination) => {
    if (destination === marker) throw Object.assign(new Error("fixture marker vanished"), { code: "EEXIST" });
    return link(source, destination);
  });
  await assert.rejects(ensure_daemon(f.state, f.root, f.profile, process.execPath, { launch: () => {
    throw Object.assign(new Error("launch outcome unknown"), { outcomeUnknown: true });
  } }), error => error.outcomeUnknown === true && error.message.includes(path.join(home, "operation.lock")));
  assert.equal(fs.existsSync(marker), false);
  await assert.rejects(operation_lock(home, () => assert.fail("must stay blocked")), error => error.code === "RUNTIME_BUSY");
});

test("a dangling maintenance symlink never permits a daemon launch", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t), home = path.join(project_home(f.state, f.root), "code-index"), marker = path.join(home, "maintenance.json");
  fs.mkdirSync(home, { recursive: true }); fs.symlinkSync(path.join(home, "missing"), marker);
  await assert.rejects(ensure_daemon(f.state, f.root, f.profile, process.execPath, { launch: () => assert.fail("must stay blocked") }),
    error => error.message.includes(marker) && error.message.includes("USAGE.md"));
  assert.equal(fs.lstatSync(marker).isSymbolicLink(), true);
});

test("an unconfirmed daemon restart keeps maintenance and is never retried automatically", async t => {
  const f = fixture(t), calls = [];
  await assert.rejects(restart_index(f.state, settings(), f.root, f.profile, {
    installed: async () => "fixture", stop: async () => calls.push("stop"),
    restart: async () => { calls.push("restart"); throw Object.assign(new Error("unconfirmed"), { outcomeUnknown: true }); },
  }), error => error.outcomeUnknown === true);
  assert.deepEqual(calls, ["stop", "restart"]);
  assert.equal(fs.existsSync(path.join(project_home(f.state, f.root), "code-index", "maintenance.json")), true);
});

test("parallel readers share exactly one owned daemon per profile and preserve unrelated processes", async (t) => {
  const f = fixture(t);
  let launches = 0;
  const io = {
    launch: (exe, args, options) => {
      launches++;
      const child = launch(
        process.execPath,
        [path.join(ROOT, "tests/fixtures/index-daemon.mjs")],
        options,
      );
      f.clients.push({ close: () => stop_child(child, 0) });
      return child;
    },
  };
  const [a, b] = await Promise.all([
    ensure_daemon(f.state, f.root, f.profile, process.execPath, io),
    ensure_daemon(f.state, f.root, f.profile, process.execPath, io),
  ]);
  assert.equal(a, b);
  assert.equal(launches, 1);
  const anotherRoot = path.join(f.base, "other", "Product");
  fs.mkdirSync(anotherRoot, { recursive: true });
  fs.writeFileSync(path.join(anotherRoot,".project"),"<projectDescription><name>Product</name></projectDescription>");
  const other = await ensure_daemon(
    f.state,
    anotherRoot,
    f.profile,
    process.execPath,
    io,
  );
  assert.notEqual(other, a);
  assert.equal(launches, 2);
  const health = await daemon_health(a),
    otherHealth = await daemon_health(other);
  assert.notEqual(health.pid, otherHealth.pid);
  const changed = structuredClone(f.profile);
  fs.mkdirSync(path.join(f.root,"extra"));
  fs.writeFileSync(path.join(f.root,"extra/.project"),"<projectDescription><name>Extra</name></projectDescription>");
  changed.repositories.push({ id: "extra", path: "extra", alias: "extra", edt_project: "extra" });
  await assert.rejects(
    ensure_daemon(f.state, f.root, changed, process.execPath, io),
    /репозиториев изменился/,
  );
  const ownerFile = path.join(a, "owner.json"),
    owner = read_json(ownerFile);
  save_json(ownerFile, { ...owner, pid: owner.pid + 1 });
  await assert.rejects(
    ensure_daemon(f.state, f.root, f.profile, process.execPath, io),
    /Владелец демона(?: проекта)? не совпадает/,
  );
  await assert.rejects(stop_daemon(f.state, f.root), /Владелец демона(?: проекта)? не совпадает/);
  assert.equal(alive(otherHealth.pid), true);
});
test("daemon stop refuses a forged owner and leaves the listening service alive", async t => {
  const f=fixture(t),home=path.join(project_home(f.state,f.root),"code-index"),hash=sha256(Buffer.from("fixture")),exe=path.join(f.state,"runtime/code-index/fixture",hash,"bsl-indexer.exe");
  fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,"fixture");
  const server=createServer((req,res)=>res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({pid:process.pid,status:"running",paths:[]})));
  server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>server.close());
  save_json(path.join(home,"daemon.json"),{pid:process.pid,http_host:"127.0.0.1",http_port:server.address().port});
  save_json(path.join(home,"owner.json"),{pid:process.pid,project_root:f.root,executable:exe});
  let invoked=false;
  await assert.rejects(stop_daemon(f.state,f.root,{stop:async()=>{invoked=true;}}),/идентичность/);
  assert.equal(invoked,false);assert.equal(server.listening,true);
});

test("daemon stop uses a verified loopback connection to its owned process", { timeout: 30000, skip: process.platform === "darwin" }, async t => {
  const f = fixture(t), digest = sha256(fs.readFileSync(process.execPath)), exe = path.join(f.state, "runtime/code-index/fixture", digest, "owned-node.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.copyFileSync(process.execPath, exe);
  if (process.platform === "linux") fs.chmodSync(exe, 0o755);
  let originalOwner;
  const launchIo = { launch: async (command, _args, options) => {
    if (process.platform === "linux") {
      const child = await spawn_guarded_linux(command, [path.join(ROOT, "tests/fixtures/index-daemon.mjs")], options);
      f.clients.push({ close: async () => {
        const home = path.join(project_home(f.state, f.root), "code-index");
        if (originalOwner && await daemon_health(home)) { save_json(path.join(home, "owner.json"), originalOwner); await stop_daemon(f.state, f.root); }
        child.release();
      } });
      return child;
    }
    const child = launch(command, [path.join(ROOT, "tests/fixtures/index-daemon.mjs")], options);
    f.clients.push({ close: () => stop_child(child, 0) }); return child;
  } };
  const home = await ensure_daemon(f.state, f.root, f.profile, exe, launchIo), ownerFile = path.join(home, "owner.json"), daemonFile = path.join(home, "daemon.json"),
    owner = read_json(ownerFile), daemon = read_json(daemonFile);
  originalOwner = owner;
  assert.ok(owner.creation); assert.equal(alive(owner.pid), true);
  save_json(daemonFile, { ...daemon, http_host: "203.0.113.1" });
  await assert.rejects(stop_daemon(f.state, f.root), /идентичность/); assert.equal(alive(owner.pid), true);
  save_json(daemonFile, daemon);
  save_json(ownerFile, { ...owner, creation: owner.creation + "-replaced" });
  await assert.rejects(stop_daemon(f.state, f.root), /идентичность|наблюдател/); assert.equal(alive(owner.pid), true);
  if (process.platform === "linux") {
    // This fixture deliberately forged the identity before any stop request
    // could be sent. Assert the durable barrier, then remove only the marker
    // created by that controlled test before exercising the legacy owner.
    const marker = path.join(home, "guard-cleanup-unknown.json");
    assert.equal(fs.existsSync(marker), true);
    save_json(ownerFile, owner);
    fs.unlinkSync(marker);
  }
  const { creation, daemon_started_at, health_started_at, guards, guardId, ...legacy } = owner;
  save_json(ownerFile, legacy);
  assert.equal(await ensure_daemon(f.state, f.root, f.profile, exe, launchIo), home, "a verified legacy daemon remains usable read-only");
  await assert.rejects(stop_daemon(f.state, f.root), /идентичность/); assert.equal(alive(owner.pid), true);
  save_json(ownerFile, owner);
  await stop_daemon(f.state, f.root);
  assert.equal(alive(owner.pid), false);
});

test("an unhealthy but live stale PID blocks competing daemon startup on every OS", async (t) => {
  const f = fixture(t),
    home = path.join(project_home(f.state, f.root), "code-index");
  save_json(path.join(home, "owner.json"), { pid: process.pid });
  const config = path.join(home, "daemon.toml"); fs.writeFileSync(config, "# existing daemon configuration\n");
  await assert.rejects(
    ensure_daemon(f.state, f.root, f.profile, process.execPath, {
      launch: () => {
        throw new Error("must not launch");
      },
    }),
    error => error.message.includes("PID") && error.message.includes(path.join(home, "owner.json")) && error.message.includes("USAGE.md"),
  );
  assert.equal(alive(process.pid), true);
  assert.equal(fs.readFileSync(config, "utf8"), "# existing daemon configuration\n");
});
test("doctor separates configuration from live acceptance and does not make OpenViking a gate", async (t) => {
  const f = fixture(t);
  environment(t, f.env);
  f.save();
  const config = settings();
  const result = await inspect(f.root, config, f.state);
  assert.equal(result.status, "error");
  assert.equal(result.full_development_readiness, "not_verified");
  const isolated = await inspect(f.root, config, f.state, false, true);
  assert.equal(isolated.status, "configured");
  assert.equal(isolated.external.edt.live, "not_verified");
  assert.equal(
    success(
      node("scripts/doctor.mjs", [f.root, "--managed-only"], { env: f.env }),
    ).status,
    "configured",
  );
});

test("CLI installation and exported bindings respect disabled components without network access", t => {
  const f=fixture(t);f.save();
  save_json(f.env.EDT_AI_SETTINGS,{mcp:{managed:{"code-index":{enabled:false},"bsl-ls":{enabled:false}}}});
  const installed=success(node("scripts/runtime.mjs",["install"],{env:f.env}));
  assert.equal(installed["code-index"].status,"disabled");assert.equal(installed["bsl-ls"].status,"disabled");
  const output=path.join(f.base,"mcp.json");success(node("scripts/runtime.mjs",["config","--output",output],{env:f.env}));
  const bindings=read_json(output).mcpServers;
  assert.equal(bindings["code-index"],undefined);assert.equal(bindings["bsl-ls"],undefined);
  assert.ok(bindings.edt.args[0].endsWith("lazy_mcp.mjs"));assert.equal(bindings.edt.env.EDT_AI_PROJECT_ROOT,f.root);
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});

test("exported MCP bindings do not list OpenViking credential variables", t => {
  const f = fixture(t);
  f.profile.connections = { openviking: { enabled: true, url: "http://127.0.0.1:1/mcp", connection_id: "team" } };
  f.save(); f.env.TEAM_KNOWLEDGE_TOKEN = "fixture-private-token";
  const output = path.join(f.base, "mcp.json");
  success(node("scripts/runtime.mjs", ["config", "--output", output], { env: f.env }));
  const contents = fs.readFileSync(output, "utf8"), exported = JSON.parse(contents), bindings = exported.mcpServers;
  assert.equal(Object.hasOwn(exported, "$schema"), false);
  for (const name of ["openviking", "edt", "v8std", "code-index", "bsl-ls"]) {
    assert.equal(Object.hasOwn(bindings[name], "env_vars"), false, name);
  }
  assert.doesNotMatch(contents, /fixture-private-token/);
});

test("native environments remove standard and configured knowledge variables without changing the caller", () => {
  const config = settings();
  const source = Object.fromEntries(["OPENVIKING_SEARCH_TOKEN", "EDT_AI_OPENVIKING_ACCESS_BINDING_KEY", "TEAM_KNOWLEDGE_TOKEN"].map(name => [name, "fixture-secret"]));
  source.PATH = "kept"; source.OTHER_PROJECT_TOKEN = "removed";
  if (process.platform === "win32") source.team_knowledge_token = "also-secret";
  assert.deepEqual(native_environment(config, source), { PATH: "kept" });
  assert.equal(source.TEAM_KNOWLEDGE_TOKEN, "fixture-secret");
});

test("daemon startup passes a sanitized environment to its native launcher", async t => {
  const f = fixture(t), home = path.join(f.base, "daemon"); fs.mkdirSync(home);
  const config = settings();
  const source = { ...process.env, OPENVIKING_SEARCH_TOKEN: "fixture-token", TEAM_KNOWLEDGE_TOKEN: "custom-token", PATH: "native-path" };
  const environment = native_environment(config, source);
  await assert.rejects(start_daemon(home, f.root, f.profile, process.execPath, { launch: (_exe, _args, options) => {
    assert.equal(options.env.OPENVIKING_SEARCH_TOKEN, undefined);
    assert.equal(options.env.TEAM_KNOWLEDGE_TOKEN, undefined);
    assert.equal(options.env.PATH, "native-path");
    assert.equal(options.env.CODE_INDEX_HOME, home);
    throw new Error("fixture launcher stopped");
  } }, environment), /fixture launcher stopped/);
});

test("index maintenance passes the sanitized environment to stop, rebuild and restart", async t => {
  const f = fixture(t), config = settings(); f.save();
  Object.assign(f.env, { OPENVIKING_SEARCH_TOKEN: "standard", TEAM_KNOWLEDGE_TOKEN: "custom", OTHER_PROJECT_TOKEN: "other" });
  environment(t, f.env);
  const calls = [], verify = (action, env) => {
    for (const name of ["OPENVIKING_SEARCH_TOKEN", "TEAM_KNOWLEDGE_TOKEN", "OTHER_PROJECT_TOKEN"]) assert.equal(env[name], undefined);
    calls.push(action);
  };
  await rebuild_index(f.state, config, f.root, f.profile, "product", {
    installed: async () => "fixture-exe",
    stop: async (_state, _root, _io, env) => verify("stop", env),
    run: async (_exe, _directory, _home, env) => verify("run", env),
    restart: async (_state, _root, _data, _exe, _io, env) => verify("restart", env),
    smoke: async () => ({ index_ready: true }),
  });
  assert.deepEqual(calls, ["stop", "run", "restart"]);
});
