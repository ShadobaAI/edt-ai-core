import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fixture, environment, node, success, ROOT } from "./helpers.mjs";
import {
  load,
  dump,
  inside,
  parse,
  settings,
  operation_lock,
  validate_settings,
} from "../scripts/common.mjs";
import { validate, validate_at, project_profile, create_profile } from "../scripts/profile.mjs";
import {
  locate_project,
  configuration_root,
  select_root,
  reconnect_file,
} from "../scripts/project_paths.mjs";
import {
  effective_settings,
  resolved_settings,
  instance_file,
} from "../scripts/project_context.mjs";
import { reason } from "../scripts/guard.mjs";
import { casefold } from "../scripts/casefold.mjs";

test("Unicode state-key case folding preserves the former Python contract", () => {
  assert.equal(casefold("Straße ẞ Σς ﬃ İ"), "strasse ss σσ ffi i\u0307");
});

test("new profile reports starter instructions without claiming content acceptance", (t) => {
  const f = fixture(t);
  const created = create_profile(f.root);
  assert.deepEqual(created.projectInstructions, {
    created: [".ai/PROJECT.md", "AGENTS.md"], preserved: [], contentValidated: false,
  });
  const agents = fs.readFileSync(path.join(f.root, "AGENTS.md"), "utf8");
  assert.match(agents, /\$1c-routing/);
  assert.match(agents, /Правила проекта требуют заполнения/);
  assert.match(agents, /Неизвестные правила не придумывай/);
  assert.deepEqual(project_profile(f.root).repositories, []);
  assert.deepEqual(fs.readdirSync(f.state), []);
  assert.deepEqual(fs.readdirSync(f.root).sort(), [".ai", "AGENTS.md", "src"]);
  assert.throws(() => create_profile(f.root), /already exists/);
  assert.equal(fs.readFileSync(path.join(f.root, "AGENTS.md"), "utf8"), agents);
});

test("profile creation preserves existing instructions byte for byte and fills only missing files", (t) => {
  for (const preserved of [["AGENTS.md"], [".ai/PROJECT.md"], ["AGENTS.md", ".ai/PROJECT.md"]]) {
    const f = fixture(t);
    const bytes = Buffer.from("\uFEFF# Собственные правила\r\nНе заменять.\r\n");
    for (const name of preserved) {
      fs.mkdirSync(path.dirname(path.join(f.root, name)), { recursive: true });
      fs.writeFileSync(path.join(f.root, name), bytes);
    }
    const result = create_profile(f.root).projectInstructions;
    assert.deepEqual([...result.preserved].sort(), [...preserved].sort());
    assert.deepEqual(result.created.sort(), [".ai/PROJECT.md", "AGENTS.md"].filter(name => !preserved.includes(name)).sort());
    assert.equal(result.contentValidated, false);
    for (const name of preserved) assert.deepEqual(fs.readFileSync(path.join(f.root, name)), bytes);
  }
});

test("profile creation bounds the generated id for a long project directory name", t => {
  const f = fixture(t), root = path.join(f.base, "project-" + "a".repeat(70));
  fs.mkdirSync(root);
  create_profile(root);
  const profile = project_profile(root);
  assert.equal(profile.project.id, path.basename(root).slice(0, 64));
});

test("unsafe supporting paths reject profile creation before any writes", (t) => {
  const f = fixture(t), outside = path.join(f.base, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, ".ai"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => create_profile(f.root));
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.ok(!fs.existsSync(path.join(f.root, "AGENTS.md")));
});

for (const name of ["AGENTS.md", ".ai/PROJECT.md", ".ai/.gitignore", "AGENTS.override.md"]) {
  test(`profile creation rejects a directory at ${name} without partial writes`, (t) => {
    const f = fixture(t), file = path.join(f.root, name);
    fs.mkdirSync(file, { recursive: true });
    const before = fs.readdirSync(f.root);
    assert.throws(() => create_profile(f.root), /must be a regular file/);
    assert.deepEqual(fs.readdirSync(f.root), before);
    assert.ok(fs.statSync(file).isDirectory());
    assert.deepEqual(fs.readdirSync(file), []);
    assert.ok(!fs.existsSync(path.join(f.root, ".ai/project.yaml")));
    assert.deepEqual(fs.readdirSync(f.state), []);
    if (fs.existsSync(path.join(f.root, ".ai")))
      assert.deepEqual(fs.readdirSync(path.join(f.root, ".ai")), [path.basename(name)]);
  });

  test(`profile creation rejects an escaping junction at ${name} before writes`, (t) => {
    const f = fixture(t), outside = path.join(f.base, "outside"), file = path.join(f.root, name);
    fs.mkdirSync(outside);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(outside, file, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => create_profile(f.root), /escapes project/);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.ok(!fs.existsSync(path.join(f.root, ".ai/project.yaml")));
  });
}

test("profile creation preserves overrides and reports precedence only for non-empty ones", (t) => {
  for (const text of ["\uFEFF# Правила override\r\nСохранить.\r\n", "\uFEFF \r\n"]) {
    const f = fixture(t), file = path.join(f.root, "AGENTS.override.md"), bytes = Buffer.from(text);
    fs.writeFileSync(file, bytes);
    const result = create_profile(f.root).projectInstructions;
    assert.deepEqual(result.created, [".ai/PROJECT.md", "AGENTS.md"]);
    assert.deepEqual(result.preserved, ["AGENTS.override.md"]);
    assert.equal(result.overrideFile, text.trim() ? "AGENTS.override.md" : undefined);
    assert.equal(result.contentValidated, false);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.ok(fs.readFileSync(path.join(f.root, "AGENTS.md"), "utf8").includes("$1c-routing"));
  }
});

test("profile creation preserves an existing local ignore file byte for byte", (t) => {
  const f = fixture(t), file = path.join(f.root, ".ai/.gitignore"), bytes = Buffer.from("\uFEFFcustom-rule\r\n");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, bytes);
  create_profile(f.root);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test("profile init/export/import/merge/no-clobber/backups preserve the full profile", (t) => {
  const f = fixture(t),
    other = path.join(f.base, "destination"),
    output = path.join(f.base, "export.yaml");
  fs.mkdirSync(other);
  success(node("scripts/profile.mjs", ["init", f.root]));
  f.profile.policy.exceptions = [
    {
      id: "format",
      selectors: ["std444"],
      repository_ids: ["product"],
      reason: "format",
      source: ".ai/PROJECT.md",
    },
  ];
  f.save();
  success(node("scripts/profile.mjs", ["export", f.root, "--output", output]));
  success(node("scripts/profile.mjs", ["import", other, "--input", output]));
  assert.deepEqual(project_profile(other), f.profile);
  assert.notEqual(
    node("scripts/profile.mjs", ["import", other, "--input", output]).status,
    0,
  );
  success(
    node("scripts/profile.mjs", [
      "import",
      other,
      "--input",
      output,
      "--merge",
    ]),
  );
  const backups = fs
    .readdirSync(path.join(other, ".ai"))
    .filter((file) => file.endsWith(".bak.yaml"));
  assert.equal(backups.length, 1);
  assert.deepEqual(load(path.join(other, ".ai", backups[0])), f.profile);
  assert.notEqual(
    node("scripts/profile.mjs", ["export", other, "--output", output]).status,
    0,
  );
  success(
    node("scripts/profile.mjs", [
      "export",
      other,
      "--output",
      output,
      "--replace",
    ]),
  );
  assert.ok(fs.existsSync(path.join(f.root, "AGENTS.md")));
});
const invalid = {
  "parent traversal": (data) => (data.repositories[0].path = "../outside"),
  "absolute drive path": (data) => (data.repositories[0].path = "C:/outside"),
  "duplicate aliases": (data) =>
    data.repositories.push({ id: "second", path: ".", alias: "product" }),
  "duplicate ids": (data) =>
    data.repositories.push({ id: "product", path: ".", alias: "second" }),
  "wrong authority": (data) => (data.authorities.edt_writer = "filesystem"),
  "schema version": (data) => (data.schema_version = "9.0"),
  "credential field": (data) => (data.policy.api_key = "example"),
  "string roots": (data) => (data.roots.source = "src"),
  "typed capabilities": (data) => (data.testing.yaxunit = "false"),
  "enabled test requires binding": (data) => (data.testing.vanessa = true),
  "unknown testing field": (data) => (data.testing.unknown = false),
  "unknown test owner": (data) => {
    data.testing.yaxunit_config = {
      repository_id: "missing",
      runner: "edt",
      results: "results",
    };
  },
  "unbound test owner": (data) => {
    data.testing.yaxunit = true;
    data.testing.yaxunit_config = {
      repository_id: "product",
      runner: "edt",
      results: "results",
    };
    data.policy.unbound_edt_repositories = ["product"];
  },
  "framework cannot own tests": (data) => {
    data.testing.yaxunit_config = {
      repository_id: "product",
      framework_repository_id: "product",
      runner: "edt",
      results: "results",
    };
  },
  "policy groups cannot weaken": (data) =>
    (data.policy.require_explicit_confirmation = []),
  "shell source cannot be enabled": (data) =>
    (data.policy.allow_shell_source_read = true),
  "overlapping bindings": (data) => {
    data.policy.edt_repository_ids = ["product"];
    data.policy.unbound_edt_repositories = ["product"];
  },
  "exception scope required": (data) =>
    (data.policy.exceptions = [
      {
        id: "one",
        selectors: ["std444"],
        repository_ids: [],
        reason: "x",
        source: "x",
      },
    ]),
  "knowledge path contained": (data) =>
    (data.knowledge.manifest = "../outside"),
  "test executable portable": (data) =>
    (data.testing.commands = [
      { id: "test", repository_id: "product", argv: ["C:/tool"], effects: [] },
    ]),
  "test owner known": (data) =>
    (data.testing.commands = [
      { id: "test", repository_id: "missing", argv: ["node"], effects: [] },
    ]),
  "URL credentials excluded": (data) =>
    (data.connections = { edt: { url: "http://user:password@localhost/mcp" } }),
};
for (const [name, change] of Object.entries(invalid))
  test("reject " + name + " before CLI import changes any bytes", (t) => {
    const f = fixture(t);
    f.save();
    const target = path.join(f.root, ".ai/project.yaml"),
      before = fs.readFileSync(target),
      bad = structuredClone(f.profile);
    change(bad);
    assert.throws(() => validate(bad));
    const input = path.join(f.base, "bad.yaml");
    dump(bad, input);
    assert.notEqual(
      node("scripts/profile.mjs", [
        "import",
        f.root,
        "--input",
        input,
        "--replace",
      ]).status,
      0,
    );
    assert.deepEqual(fs.readFileSync(target), before);
    assert.equal(
      fs
        .readdirSync(path.dirname(target))
        .filter((name) => name.endsWith(".bak.yaml")).length,
      0,
    );
  });
test("strict YAML, URL/settings types and generic-only presets", (t) => {
  const f = fixture(t);
  assert.throws(() => parse("a: 1\na: 2"));
  assert.throws(() => parse("[]"));
  assert.throws(() => parse("purpose: !unsupported value"));
  assert.throws(() => parse("a: &a [*a, *a, *a]\nb: [*a, *a, *a]".repeat(100)));
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "profiles")), ["generic-1c"]);
  for (const preset of ["crm", "kafka"])
    assert.notEqual(
      node("scripts/profile.mjs", ["init", f.root, "--profile", preset]).status,
      0,
    );
  for (const url of [
    "ftp://localhost/mcp",
    "http://localhost:99999/mcp",
    "http://localhost:0/mcp",
    "http://localhost/mcp#x",
  ]) {
    const config = settings();
    config.mcp.required.edt.url = url;
    assert.throws(() => validate_settings(config));
  }
});
test("profile and paths respect symlinks and nested Git boundaries", (t) => {
  const f = fixture(t);
  f.save();
  const sub = path.join(f.root, "docs");
  fs.mkdirSync(sub);
  assert.equal(locate_project(sub), f.root);
  assert.equal(configuration_root(sub), f.root);
  fs.mkdirSync(path.join(sub, ".git"));
  assert.throws(() => locate_project(sub));
  assert.equal(configuration_root(sub), sub);
  const outside = path.join(f.base, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(
    outside,
    path.join(f.root, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => inside(f.root, "link/new"));
  assert.throws(() => inside(f.root, "../outside"));
  const bad = structuredClone(f.profile);
  bad.repositories.push({ id: "tests", path: "tests", alias: "tests" });
  bad.testing.vanessa_config = {
    repository_id: "tests",
    runtime_profile: "ui.json",
    features: "src",
    results: "results",
    server_name: "vanessa",
  };
  assert.throws(() => validate_at(f.root, bad));
});
test("connection precedence and scoped instance keys perform no implicit writes", (t) => {
  const f = fixture(t);
  environment(t, f.env);
  f.profile.connections = { edt: { url: "http://localhost:18001/mcp" } };
  f.save();
  const config = settings();
  assert.equal(
    effective_settings(config, f.root, f.profile).mcp.required.edt.url,
    f.profile.connections.edt.url,
  );
  dump(
    { connections: { edt: { url: "http://localhost:18002/mcp" } } },
    path.join(f.root, ".ai/project.local.yaml"),
  );
  dump(
    { connections: { edt: { url: "http://localhost:18003/mcp" } } },
    path.join(f.root, ".ai/instances/first.local.yaml"),
  );
  const first = instance_file(config, f.root);
  dump({ connections: { edt: { url: "http://localhost:18004/mcp" } } }, first);
  assert.equal(
    effective_settings(config, f.root, f.profile).mcp.required.edt.url,
    "http://localhost:18004/mcp",
  );
  const explicit = path.join(f.base, "connections.yaml");
  dump(
    { connections: { edt: { url: "http://localhost:18005/mcp" } } },
    explicit,
  );
  process.env.EDT_AI_CONNECTIONS_FILE = explicit;
  assert.equal(
    resolved_settings(config, f.root, f.profile)[1].edt,
    "connections_file",
  );
  process.env.EDT_AI_EDT_URL = "http://localhost:18006/mcp";
  assert.equal(
    effective_settings(config, f.root, f.profile).mcp.required.edt.url,
    process.env.EDT_AI_EDT_URL,
  );
  process.env.EDT_AI_INSTANCE = "second";
  assert.notEqual(instance_file(config, f.root), first);
  assert.notEqual(
    reconnect_file(f.state, f.root),
    reconnect_file(f.state, f.base),
  );
  delete process.env.EDT_AI_EDT_URL;
  process.env.EDT_AI_CONNECTIONS_FILE = path.join(f.base, "missing");
  assert.throws(
    () => effective_settings(config, f.root, f.profile),
    /existing override/,
  );
});
test("legacy EDT URL never crosses project ownership; custom env and host roots remain local", (t) => {
  const f = fixture(t);
  environment(t, f.env);
  f.save();
  const config = settings();
  config.active_project = f.base;
  config.mcp.required.edt.url = "http://localhost:18009/mcp";
  config.mcp.required.v8std.url = "http://localhost:18010/mcp";
  const effective = effective_settings(config, f.root, f.profile);
  assert.equal(effective.mcp.required.edt.url, "");
  config.active_project = null;
  assert.equal(effective_settings(config, f.root, f.profile).mcp.required.edt.url, "");
  assert.equal(effective.mcp.required.v8std.url, config.mcp.required.v8std.url);
  f.profile.connections = {
    edt: { url: "http://localhost/mcp", url_env: "CUSTOM_EDT" },
  };
  process.env.CUSTOM_EDT = "http://localhost:18011/mcp";
  assert.equal(
    effective_settings(config, f.root, f.profile).mcp.required.edt.url,
    process.env.CUSTOM_EDT,
  );
  assert.equal(
    select_root([{ uri: pathToFileURL(f.root).href }], f.base),
    f.root,
  );
  assert.throws(
    () =>
      select_root(
        [
          { uri: pathToFileURL(f.root).href },
          { uri: pathToFileURL(f.state).href },
        ],
        f.base,
      ),
    /ambiguous/,
  );
  assert.throws(() => select_root([{ uri: "https://localhost/" }], f.root));
});
test("operation lock excludes concurrent writers without deleting their lock", async (t) => {
  const f = fixture(t);
  await operation_lock(f.state, async () => {
    await assert.rejects(
      operation_lock(f.state, () => {}),
      /Another runtime operation/,
    );
    assert.ok(fs.existsSync(path.join(f.state, "operation.lock")));
  });
  assert.ok(!fs.existsSync(path.join(f.state, "operation.lock")));
});
test("guard rejects reads, writes, patches, traversal, broad discovery, shell and aliases", (t) => {
  const f = fixture(t);
  f.save();
  for (const [tool_name, tool_input] of [
    ["Read", { path: "src/Module.bsl" }],
    ["Write", { path: "src/New.bsl" }],
    ["Read", { path: "docs/../src/Module.bsl" }],
    [
      "apply_patch",
      { patch: "*** Update File: docs/a.md\n*** Move to: src/a.bsl" },
    ],
    [
      "apply_patch",
      { patch: "*** Update File: src/a.bsl\n*** Move to: docs/a.md" },
    ],
    ["Glob", {}],
    ["mcp__filesystem__move_file", { source: "src/Module.bsl", destination: "docs/Module.bsl" }],
    ["mcp__filesystem__move_file", { source: "docs/Module.bsl", destination: "src/Module.bsl" }],
    ["mcp__filesystem__move_file", { source: f.root, destination: path.join(f.base, "renamed") }],
    ["mcp__filesystem__list_directory", { path: f.root }],
    ["mcp__filesystem__list_directory_with_sizes", { path: f.root }],
    ["mcp__filesystem__search_files", { path: f.root, pattern: "**/*.bsl" }],
    ["mcp__filesystem__directory_tree", { path: f.root }],
    ["exec_command", { cmd: "node -v", workdir: "." }],
    ["exec", { code: "tools.exec_command(...)" }],
    ["mcp__code_index.search", { repo: "foreign" }],
    ["mcp__code_index__core_runtime_call", { calls: [{ name: "search", arguments: { repo: "product" } }, { name: "search", arguments: { repo: "foreign" } }] }],
    ["mcp__code_index__core_runtime_call", { calls: [{ name: "search", arguments: null }] }],
  ])
    assert.ok(reason({ cwd: f.root, tool_name, tool_input }), tool_name);
  for (const [tool_name, tool_input] of [
    ["Read", { path: "docs/a.md" }],
    ["mcp__filesystem__move_file", { source: "docs/old.md", destination: "docs/new.md" }],
    ["mcp__filesystem__list_directory", { path: "docs" }],
    ["mcp__filesystem__list_directory_with_sizes", { path: "docs" }],
    ["mcp__filesystem__search_files", { path: "docs", pattern: "**/*.md" }],
    ["mcp__filesystem__directory_tree", { path: "docs" }],
    ["mcp__edt.read", { path: "src/a.bsl" }],
    ["mcp__code_index.search", { repo: "product" }],
    ["mcp__code_index__core_runtime_call", { calls: [{ name: "search", arguments: { repo: "product" } }] }],
    ["exec_command", { cmd: "node -v", workdir: "docs" }],
  ])
    assert.equal(
      reason({ cwd: f.root, tool_name, tool_input }),
      null,
      tool_name,
    );
  const result = node("hooks/guard.mjs", [], {
    input: JSON.stringify({
      cwd: f.root,
      tool_name: "Read",
      tool_input: { path: "src/a.bsl" },
    }),
  });
  assert.equal(success(result).hookSpecificOutput.permissionDecision, "deny");
  fs.writeFileSync(path.join(f.root, ".ai/project.yaml"), "invalid");
  assert.equal(
    success(
      node("hooks/guard.mjs", [], {
        input: JSON.stringify({
          cwd: f.root,
          tool_name: "Read",
          tool_input: { path: "docs/a.md" },
        }),
      }),
    ).hookSpecificOutput.permissionDecision,
    "deny",
  );
});

test("prepared hooks share their local settings and state while preserving explicit environment and chat scope", t => {
  const f = fixture(t); f.save();
  const plugin = path.join(f.base, "hook-copy");
  const files = ["plugin.json", "vendor/deps.mjs", "settings/defaults.json", "policy/default.json",
    ...["project-profile", "plugin-settings", "project-local"].map(name => `schemas/${name}.schema.json`),
    ...["project_paths", "casefold", "common", "guard", "profile", "action_policy", "compatibility", "knowledge",
      "project_context", "directory_context", "diagnostics", "selection"].map(name => `scripts/${name}.mjs`),
    "hooks/guard.mjs", "hooks/session-start.mjs"];
  for (const name of files) {
    const target = path.join(plugin, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, name), target);
  }
  const env = { ...f.env, CODEX_HOME: path.join(f.base, "empty-host") };
  delete env.EDT_AI_STATE_DIR; delete env.EDT_AI_SETTINGS;
  const run = (hook, event, extra = {}) => success(node(path.join(plugin, "hooks", hook + ".mjs"), [], {
    cwd: f.root, env: { ...env, ...extra }, input: JSON.stringify({ cwd: f.root, ...event }),
  }));
  const event = { tool_name: "mcp__edt__list_projects", tool_input: {} };
  assert.deepEqual(run("guard", event), {}, "portable copies need no local runtime file");
  const config = load(path.join(ROOT, "settings/defaults.json"));
  config.state_dir = f.state;
  config.mcp.optional.openviking = { ...config.mcp.optional.openviking, enabled: true, url: "http://localhost:12345/mcp" };
  const configPath = path.join(f.state, "custom-settings.json"), runtimePath = path.join(plugin, "hooks/runtime.local.json");
  dump(config, configPath);
  const runtime = { node: process.execPath, state: f.state, settings: configPath,
    projectRoot: f.state, instance: "other" };
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  assert.equal(run("guard", event).hookSpecificOutput.permissionDecision, "deny", "custom settings retain the invalid knowledge gate");
  assert.match(run("session-start", {}).hookSpecificOutput.additionalContext, /selected chat directory/);
  const events = fs.readFileSync(path.join(f.state, "diagnostics/events.0.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(new Set(events.map(item => item.component)), new Set(["guard", "session-start"]));
  assert.ok(events.every(item => item.instance === "first"));
  assert.equal(events.find(item => item.component === "session-start").detail.projectRoot, f.root);
  const overrideState = path.join(f.base, "override-state"), overrideSettings = path.join(f.base, "override-settings.json");
  dump(load(path.join(ROOT, "settings/defaults.json")), overrideSettings);
  const explicit = { EDT_AI_STATE_DIR: overrideState, EDT_AI_SETTINGS: overrideSettings };
  assert.deepEqual(run("guard", event, explicit), {}, "environment settings override prepared defaults");
  run("guard", { tool_name: "Read", tool_input: { path: "src/Module.bsl" } }, explicit);
  assert.ok(fs.existsSync(path.join(overrideState, "diagnostics/events.0.jsonl")), "environment state receives hook diagnostics");
  assert.equal(fs.readFileSync(path.join(f.state, "diagnostics/events.0.jsonl"), "utf8").trim().split("\n").length, events.length);
  for (const invalid of ["{", JSON.stringify({ ...runtime, state: "relative" }), JSON.stringify({ ...runtime, settings: 42 })]) {
    fs.writeFileSync(runtimePath, invalid);
    assert.equal(run("guard", event).hookSpecificOutput.permissionDecision, "deny", "invalid prepared runtime fails closed");
  }
});
