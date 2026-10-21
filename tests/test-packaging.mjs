import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fixture, environment, ROOT } from "./helpers.mjs";
import { package_plugin } from "../tools/package-plugin.mjs";
import { verify } from "../tools/verify-package.mjs";
import { check } from "../tools/check-plugin.mjs";
import {
  compare_version,
  version_key,
  resolve_version,
} from "../tools/release_policy.mjs";
import {
  validate_run,
  validate_build,
  validate_source_tag,
  update_catalog,
  stage_release,
  push_release,
  clone_marketplace,
  publish,
  run,
  git_environment,
} from "../tools/publish-marketplace.mjs";
import { sha256 } from "../scripts/project_paths.mjs";
import { build as prepare } from "../scripts/prepare_install.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import {
  windows_process_identity,
  same_creation,
} from "../scripts/windows_process.mjs";
import { launch, stop_child, alive } from "../scripts/processes.mjs";
import { sleep } from "../scripts/common.mjs";

test("reproducible ZIPs include bundled dependencies, exclude state/tooling and survive Node-only extracted smoke", async (t) => {
  const f = fixture(t),
    manifest = fs.readFileSync(path.join(ROOT, "plugin.json")),
    first = package_plugin(),
    hash = first.archives.map((file) => sha256(fs.readFileSync(file)));
  assert.deepEqual(
    package_plugin().archives.map((file) => sha256(fs.readFileSync(file))),
    hash,
  );
  assert.deepEqual(fs.readFileSync(path.join(ROOT, "plugin.json")), manifest);
  const extracted = path.join(f.base, "extracted plugin"),
    info = verify(path.join(ROOT, ".build"), extracted);
  assert.equal(info.plugin, "1c-ai-core");
  const result = await check(path.join(extracted, "plugins/1c-ai-core"));
  assert.equal(result.runtime, "node-only");
  const download = path.join(f.base, "download");
  fs.mkdirSync(download);
  for (const name of [
    "SHA256SUMS",
    ...first.archives.map((file) => path.basename(file)),
  ])
    fs.copyFileSync(path.join(ROOT, ".build", name), path.join(download, name));
  fs.appendFileSync(
    path.join(download, path.basename(first.archives[0])),
    "corrupt",
  );
  const destination = path.join(f.base, "bad");
  assert.throws(() => verify(download, destination), /Checksum mismatch/);
  assert.ok(!fs.existsSync(destination));
});
test("build validates all inputs before removing a previous build and refuses escaped output", (t) => {
  const f = fixture(t),
    previous = package_plugin(),
    before = sha256(fs.readFileSync(previous.archives[0]));
  assert.throws(
    () => package_plugin(path.join(f.base, "outside")),
    /Output must/,
  );
  assert.equal(sha256(fs.readFileSync(previous.archives[0])), before);
  // Rename one required input only within this test and restore it even on failure.
  const file = path.join(ROOT, "settings/local.example.yaml"),
    saved = file + ".test-backup";
  fs.renameSync(file, saved);
  try {
    assert.throws(() => package_plugin());
    assert.equal(sha256(fs.readFileSync(previous.archives[0])), before);
  } finally {
    fs.renameSync(saved, file);
  }
});
test("stable version ordering, untagged initial checkout and release-tag override protection", (t) => {
  const f = fixture(t);
  environment(t, f.env);
  assert.ok(compare_version("1.10.0", "1.9.9") > 0);
  for (const version of ["v1.0.0", "01.0.0", "1.0", "1.0.0-rc.1", "1.0.0\n"])
    assert.throws(() => version_key(version));
  fs.writeFileSync(
    path.join(f.root, "plugin.json"),
    '{"name":"1c-ai-core","version":"0.2.1"}',
  );
  assert.equal(resolve_version(f.root), "0.2.1");
  process.env.GITHUB_ACTIONS = "true";
  process.env.GITHUB_REF_TYPE = "tag";
  process.env.GITHUB_REF_NAME = "1.2.3";
  assert.equal(resolve_version(ROOT), "1.2.3");
  assert.throws(() => resolve_version(ROOT, "1.2.4"), /triggering/);
});
test("release validation rejects foreign, branch, failed, dirty and mismatched artifacts before publication", (t) => {
  const f = fixture(t),
    record = {
      id: 42,
      repository: { full_name: "ShadobaAI/edt-ai-core" },
      head_repository: { full_name: "ShadobaAI/edt-ai-core" },
      path: ".github/workflows/build-plugin.yml",
      event: "push",
      conclusion: "success",
      head_branch: "1.2.3",
      head_sha: "abc",
    },
    build = {
      profile: "release",
      dirty: false,
      revision: "abc",
      version: "1.2.3",
      runId: "42",
    };
  validate_run(record);
  validate_build(build, record);
  for (const changed of [
    { event: "pull_request" },
    { conclusion: "failure" },
    { head_branch: "main" },
    { repository: { full_name: "foreign/source" } },
    { head_repository: { full_name: "foreign/fork" } },
  ])
    assert.throws(() => validate_run({ ...record, ...changed }));
  for (const changed of [
    { dirty: true },
    { profile: "dev" },
    { revision: "other" },
    { runId: 41 },
    { version: "1.2.4" },
  ])
    assert.throws(() => validate_build({ ...build, ...changed }, record));
  environment(t, { ...f.env, GITHUB_REPOSITORY: "ShadobaAI/edt-ai-core" });
  delete process.env.MARKETPLACE_TOKEN;
  let calls = 0;
  assert.throws(
    () =>
      publish("42", path.join(f.base, "publication"), () => {
        calls++;
        return JSON.stringify(record);
      }),
    /MARKETPLACE_TOKEN/,
  );
  assert.equal(calls, 1);
  assert.ok(!fs.existsSync(path.join(f.base, "publication")));
});
test("tag validation peels annotated/lightweight tags and rejects moved revisions", () => {
  const calls = [],
    build = { version: "1.2.3", revision: "abc" },
    exec = (args) => {
      calls.push(args);
      return args[1] === "rev-parse" ? "abc" : "";
    };
  validate_source_tag("fixture", build, exec);
  assert.ok(calls.some((args) => args.includes("FETCH_HEAD^{commit}")));
  assert.throws(
    () =>
      validate_source_tag("fixture", build, (args) =>
        args[1] === "rev-parse" ? "moved" : "",
      ),
    /no longer/,
  );
});
test("publication Git authentication is per-command and requires no shell credential helper", () => {
  const source = git_environment("source-fixture"),
    target = git_environment("target-fixture");
  assert.equal(source.GIT_CONFIG_VALUE_0, "");
  assert.notEqual(source.GIT_CONFIG_VALUE_1, target.GIT_CONFIG_VALUE_1);
  assert.ok(!source.GIT_CONFIG_VALUE_1.includes("source-fixture"));
  assert.equal(source.GIT_TERMINAL_PROMPT, "0");
});
test("catalog merging preserves unrelated plugins, order, interface and metadata", (t) => {
  const f = fixture(t),
    payload = package_plugin(),
    incoming = path.dirname(path.dirname(payload.plugin));
  const catalog = path.join(f.root, ".agents/plugins/marketplace.json");
  fs.mkdirSync(path.dirname(catalog), { recursive: true });
  fs.writeFileSync(
    catalog,
    JSON.stringify({
      name: "previous",
      interface: { custom: true },
      extra: "keep",
      plugins: [
        { name: "other", source: { source: "local", path: "./other" } },
        { name: "1c-ai-core", old: true },
      ],
    }),
  );
  update_catalog(f.root, incoming);
  const result = JSON.parse(fs.readFileSync(catalog, "utf8"));
  assert.deepEqual(
    result.plugins.map((item) => item.name),
    ["other", "1c-ai-core"],
  );
  assert.equal(result.interface.custom, true);
  assert.equal(result.extra, "keep");
  result.plugins.push(result.plugins[0]);
  fs.writeFileSync(catalog, JSON.stringify(result));
  assert.throws(() => update_catalog(f.root, incoming), /Duplicate plugin/);
});
test("publication pushes only a dedicated local catalog clone and handles an initially empty main", (t) => {
  const f = fixture(t),
    bare = path.join(f.base, "store.git"),
    checkout = path.join(f.base, "catalog");
  run(["git", "init", "--bare", bare]);
  const exec = (args, options) =>
    run(
      args[0] === "git" && args[1] === "clone"
        ? ["git", "clone", bare, args.at(-1)]
        : args,
      options,
    );
  clone_marketplace(checkout, process.env, exec);
  const packaged = package_plugin(),
    payload = path.dirname(path.dirname(packaged.plugin)),
    build = JSON.parse(
      fs.readFileSync(path.join(packaged.plugin, "build-info.json")),
    );
  push_release(checkout, payload, ROOT, build, process.env, exec);
  assert.equal(
    run(["git", "rev-parse", "refs/heads/main"], { cwd: bare }),
    run(["git", "rev-parse", "HEAD"], { cwd: checkout }),
  );
  assert.equal(stage_release(checkout, payload, ROOT, build, exec), false);
  assert.throws(
    () =>
      stage_release(
        checkout,
        payload,
        ROOT,
        { ...build, version: "0.0.1" },
        exec,
      ),
    /roll back/,
  );
});
test("publication bounded conflict recovery preserves a concurrently published plugin", (t) => {
  const f = fixture(t),
    bare = path.join(f.base, "store.git"),
    checkout = path.join(f.base, "catalog");
  run(["git", "init", "--bare", bare]);
  const exec = (args, options) =>
    run(
      args[0] === "git" && args[1] === "clone"
        ? ["git", "clone", bare, args.at(-1)]
        : args,
      options,
    );
  clone_marketplace(checkout, process.env, exec);
  const packaged = package_plugin(),
    payload = path.dirname(path.dirname(packaged.plugin)),
    build = JSON.parse(
      fs.readFileSync(path.join(packaged.plugin, "build-info.json")),
    );
  push_release(checkout, payload, ROOT, build, process.env, exec);
  const newer = { ...build, version: "9.9.9" },
    newerPayload = path.join(f.base, "newer");
  fs.cpSync(payload, newerPayload, { recursive: true });
  fs.writeFileSync(
    path.join(newerPayload, "plugins/1c-ai-core/build-info.json"),
    JSON.stringify(newer),
  );
  let pushes = 0;
  const conflicting = (args, options) => {
    if (args[0] === "git" && args[1] === "push" && pushes++ === 0) {
      const competitor = path.join(f.base, "competitor");
      run(["git", "clone", "--branch", "main", bare, competitor]);
      run(["git", "config", "user.name", "fixture"], { cwd: competitor });
      run(["git", "config", "user.email", "fixture@example.invalid"], {
        cwd: competitor,
      });
      const file = path.join(competitor, ".agents/plugins/marketplace.json"),
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      data.plugins.push({
        name: "other-plugin",
        source: { source: "local", path: "./plugins/other" },
      });
      fs.writeFileSync(file, JSON.stringify(data));
      run(["git", "add", "."], { cwd: competitor });
      run(["git", "commit", "-m", "concurrent plugin"], { cwd: competitor });
      run(["git", "push", "origin", "HEAD:refs/heads/main"], {
        cwd: competitor,
      });
    }
    return exec(args, options);
  };
  push_release(checkout, newerPayload, ROOT, newer, process.env, conflicting);
  assert.equal(pushes, 2);
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(checkout, ".agents/plugins/marketplace.json"),
      "utf8",
    ),
  );
  assert.ok(catalog.plugins.some((plugin) => plugin.name === "other-plugin"));
});
test("prepared local marketplace preserves legacy YAML and runs with Node alone", async (t) => {
  const f = fixture(t);
  f.save();
  fs.writeFileSync(
    path.join(f.state, "settings.yaml"),
    "mcp:\n  required:\n    edt:\n      url: http://localhost:18201/mcp\n",
  );
  const result = prepare(path.join(f.base, "prepared"), f.state);
  assert.equal(result.node, fs.realpathSync.native(process.execPath));
  assert.equal(
    JSON.parse(fs.readFileSync(result.settings, "utf8")).mcp.required.edt.url,
    "http://localhost:18201/mcp",
  );
  const client = new McpClient(
    [
      process.execPath,
      path.join(
        result.marketplace,
        "plugins/1c-ai-core/policy/read-only-mcp.mjs",
      ),
    ],
    f.root,
    f.env,
    10,
  );
  f.clients.push(client);
  await client.initialize();
  assert.equal((await client.request("tools/list")).tools.length, 6);
});
test("owned process tree termination leaves unrelated processes alive", async (t) => {
  const f = fixture(t),
    file = path.join(f.base, "parent.mjs"),
    pidFile = path.join(f.base, "child.pid");
  fs.writeFileSync(
    file,
    `import {spawn} from 'node:child_process'; import fs from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); fs.writeFileSync(process.argv[2],String(child.pid)); setInterval(()=>{},1000);`,
  );
  const parent = launch(process.execPath, [file, pidFile], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  f.clients.push({ close: () => stop_child(parent, 0) });
  for (let i = 0; i < 500 && !fs.existsSync(pidFile); i++) await sleep(10);
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(alive(childPid));
  await stop_child(parent, 0);
  for (let i = 0; i < 100 && alive(childPid); i++) await sleep(10);
  assert.equal(alive(childPid), false);
  assert.equal(alive(process.pid), true);
});
test(
  "Windows shared daemon survives its reader job and preserves arguments, Unicode environment and append logs",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = fixture(t),
      file = path.join(f.base, "reader.mjs"),
      pidFile = path.join(f.base, "daemon.pid"),
      stdoutFile = path.join(f.base, "stdout Юникод.log"),
      stderrFile = path.join(f.base, "stderr Юникод.log"),
      args = [
        "Юникод с пробелом",
        'quoted"argument',
        "\\tail\\",
        "",
        'slashes\\\\"end\\',
      ],
      childCode = `process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.DAEMON_TEST})); process.stderr.write('stderr retained'); setTimeout(()=>{},2500);`;
    fs.writeFileSync(stdoutFile, "previous\n");
    fs.writeFileSync(
      file,
      `import {spawn_detached_windows} from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts/windows_process.mjs")).href)};
import fs from 'node:fs';
const child=spawn_detached_windows(process.execPath,${JSON.stringify(["-e", childCode, ...args])},{cwd:${JSON.stringify(f.root)},env:{...process.env,DAEMON_TEST:'Юникод значение'},stdoutFile:${JSON.stringify(stdoutFile)},stderrFile:${JSON.stringify(stderrFile)}});
child.release(); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`,
    );
    const parent = launch(process.execPath, [file], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let errors = "",
      childPid;
    parent.stderr.on("data", (data) => (errors += data));
    f.clients.push({
      close: async () => {
        await stop_child(parent, 0);
        for (let i = 0; i < 400 && alive(childPid); i++) await sleep(25);
        assert.equal(
          alive(childPid),
          false,
          "detached fixture must exit naturally",
        );
      },
    });
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await sleep(15);
    assert.ok(fs.existsSync(pidFile), errors);
    childPid = Number(fs.readFileSync(pidFile, "utf8"));
    for (
      let i = 0;
      i < 200 && !fs.readFileSync(stdoutFile, "utf8").includes("args");
      i++
    )
      await sleep(15);
    await stop_child(parent, 0);
    assert.equal(
      alive(childPid),
      true,
      "closing the reader Job must preserve the shared daemon",
    );
    const output = fs.readFileSync(stdoutFile, "utf8");
    assert.ok(output.startsWith("previous\n"));
    assert.deepEqual(JSON.parse(output.slice("previous\n".length)), {
      args,
      cwd: f.root,
      env: "Юникод значение",
    });
    assert.equal(fs.readFileSync(stderrFile, "utf8"), "stderr retained");
  },
);
test(
  "Windows native process identity checks executable, exact creation and legacy CIM timestamps",
  { skip: process.platform !== "win32" },
  () => {
    const state = windows_process_identity(process.pid);
    assert.equal(
      state.executable.toLowerCase(),
      process.execPath.toLowerCase(),
    );
    assert.equal(same_creation(state, state.created), true);
    assert.equal(same_creation(state, "/Date(" + state.createdMs + ")/"), true);
    assert.equal(same_creation(state, "win32-filetime:1"), false);
    assert.equal(windows_process_identity(0xfffffffe), null);
  },
);
