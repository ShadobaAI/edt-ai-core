import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fixture, environment, session, ROOT } from "./helpers.mjs";
import { SettingsBackend } from "../scripts/settings_backend.mjs";
import { private_atomic_write } from "../scripts/openviking_store.mjs";
import { WORKFLOW_ACTIONS } from "../scripts/knowledge.mjs";

function setup(t) {
  const f = fixture(t); environment(t, f.env);
  f.profile.testing.vanessa = true;
  f.profile.testing.vanessa_config = { repository_id: "product", runtime_profile: ".ai/vanessa.local.json", features: "features", results: "results", server_name: "vanessa" };
  f.save();
  const user = name => ({ name, password: "secret-9826", interface: "taxi" });
  const runtime = { version: 1, id: "ui-tests", projectRoot: "..", platform: "../1cv8c.exe", runtime: { epf: "../vanessa.epf" },
    manager: { infobase: { type: "server", server: "localhost", database: "manager" }, user: user("Manager") },
    infobase: { type: "file", path: "../base" }, users: { TestClient: user("Test") },
    mcp: { serverName: "vanessa", url: "http://127.0.0.1:19876/mcp", port: 19876 }, features: "../features", results: "../results" };
  const file = path.join(f.root, ".ai", "vanessa.local.json");
  const save = () => fs.writeFileSync(file, JSON.stringify(runtime, null, 2)); save();
  return { ...f, runtime, file, saveRuntime: save, backend: new SettingsBackend() };
}

test("runtime editor reads, validates and saves the complete selected profile with an optimistic revision", async t => {
  const f = setup(t), original = await f.backend.main({ action: "vanessa_read" });
  assert.equal(original.profile.users.TestClient.password, "secret-9826");
  original.profile.users.Operator = { name: "Operator", password: "another-secret", interface: "taxi" };
  original.profile.runtime.paramsFile = "../params.json";
  original.profile.limits = { timeoutMs: 5000, maxBytes: 4096 };
  const saved = await f.backend.main({ action: "vanessa_save", profile: original.profile, expectedRevision: original.revision });
  assert.equal(saved.status, "saved");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), original.profile);
  assert.notEqual(saved.revision, original.revision);
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: original.profile, expectedRevision: original.revision }), /изменил/);
});

test("runtime editor creates a draft from the project binding and rejects unsafe or incompatible values", async t => {
  const f = setup(t); fs.unlinkSync(f.file);
  const draft = await f.backend.main({ action: "vanessa_read" });
  assert.equal(draft.exists, false); assert.equal(draft.profile.projectRoot, "..");
  assert.equal(draft.profile.features, "../features"); assert.equal(draft.profile.mcp.serverName, "vanessa");
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision }));
  for (const mutate of [
    p => { p.projectRoot = "../other"; },
    p => { p.features = "../other"; },
    p => { p.mcp.serverName = "other"; },
    p => { p.mcp.url = "https://example.com/mcp"; },
    p => { p.manager.infobase.server = "bad;server"; },
  ]) {
    const profile = structuredClone(f.runtime); mutate(profile);
    await assert.rejects(f.backend.main({ action: "vanessa_save", profile, expectedRevision: draft.revision }));
    assert.equal(fs.existsSync(f.file), false);
  }
  await f.backend.main({ action: "vanessa_save", profile: f.runtime, expectedRevision: draft.revision });
  assert.equal(fs.existsSync(f.file), true);
});

test("runtime editor refuses protected source paths and invalidates drafts when project bindings change", async t => {
  const f = setup(t), draft = await f.backend.main({ action: "vanessa_read" });
  f.profile.testing.vanessa_config.server_name = "other"; f.save();
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision }), /изменил/);
  f.profile.testing.vanessa_config.runtime_profile = "src/runtime.json"; f.save();
  await assert.rejects(f.backend.main({ action: "vanessa_read" }), /защищённых исходниках/);
});

test("runtime profile containing passwords must be untracked and ignored by Git", async t => {
  const f = setup(t), git = (...args) => spawnSync("git", ["-C", f.root, ...args], { windowsHide: true, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  const draft = await f.backend.main({ action: "vanessa_read" }); draft.profile.id = "changed";
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision }), /Исключите runtime-профиль/);
  fs.writeFileSync(path.join(f.root, ".gitignore"), ".ai/vanessa.local.json\n");
  await f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision });
  assert.equal(git("add", "-f", ".ai/vanessa.local.json").status, 0);
  const tracked = await f.backend.main({ action: "vanessa_read" }); tracked.profile.id = "tracked";
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: tracked.profile, expectedRevision: tracked.revision }), /отслеживается Git/);
});

for (const separateGitDir of [false, true]) test(`runtime profile cannot overwrite a file tracked by an enclosing repository${separateGitDir ? " with an inner gitfile" : ""}`, async t => {
  const f = setup(t), git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8" });
  assert.equal(git(f.base, "init", "-q").status, 0);
  assert.equal(git(f.base, "add", "--", "Product/.ai/vanessa.local.json").status, 0);
  assert.equal(git(f.root, "init", "-q", ...(separateGitDir ? ["--separate-git-dir", path.join(f.base, "inner-git")] : [])).status, 0);
  fs.writeFileSync(path.join(f.root, ".gitignore"), ".ai/vanessa.local.json\n");
  assert.equal(git(f.root, "check-ignore", "-q", "--", f.file).status, 0);
  const before = fs.readFileSync(f.file), draft = await f.backend.main({ action: "vanessa_read" });
  draft.profile.id = "changed";
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision }), /отслеживается Git/);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(git(f.base, "rm", "--cached", "--", "Product/.ai/vanessa.local.json").status, 0);
  assert.equal((await f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision })).status, "saved");
});

test("Git checks the literal runtime profile path when its name contains pathspec metacharacters", async t => {
  const f = setup(t), file = path.join(f.root, ".ai", "vanessa[1].json");
  fs.renameSync(f.file, file); f.profile.testing.vanessa_config.runtime_profile = ".ai/vanessa[1].json"; f.save();
  const git = (...args) => spawnSync("git", ["--literal-pathspecs", "-C", f.root, ...args], { windowsHide: true, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  fs.writeFileSync(path.join(f.root, ".gitignore"), ".ai/*.json\n");
  assert.equal(git("add", "-f", "--", file).status, 0);
  const before = fs.readFileSync(file), draft = await f.backend.main({ action: "vanessa_read" }); draft.profile.id = "changed";
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision }), /отслеживается Git/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(git("rm", "--cached", "--", file).status, 0);
  assert.equal((await f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision })).status, "saved");
});

for (const [indexed, renamed] of [
  [".ai/vanessa[1].json", ".AI/Vanessa[1].JSON"],
  [".ai/пароль.json", ".ai/ПАРОЛЬ.JSON"],
]) for (const missing of [false, true]) for (const ignoreCase of [false, true])
  test(`Windows rejects a tracked case alias ${indexed}, missing=${missing}, core.ignorecase=${ignoreCase}`, { skip: process.platform !== "win32" }, async t => {
    const f = setup(t), original = path.join(f.root, indexed), changed = path.join(f.root, renamed);
    fs.renameSync(f.file, original);
    const git = (...args) => spawnSync("git", ["-C", f.root, ...args], { windowsHide: true, encoding: "utf8" });
    assert.equal(git("init", "-q").status, 0);
    assert.equal(git("config", "core.ignorecase", String(ignoreCase)).status, 0);
    fs.writeFileSync(path.join(f.root, ".gitignore"), "*.json\n*.JSON\n");
    assert.equal(git("add", "-f", "--", ":(literal)" + indexed).status, 0);
    const intermediate = path.join(path.dirname(original), "case-swap.json");
    fs.renameSync(original, intermediate); fs.renameSync(intermediate, path.join(path.dirname(original), path.basename(changed)));
    if (path.dirname(indexed) !== path.dirname(renamed)) {
      const directory = path.dirname(original), moved = directory + ".swap";
      fs.renameSync(directory, moved); fs.renameSync(moved, path.dirname(changed));
    }
    if (missing) fs.unlinkSync(changed);
    f.profile.testing.vanessa_config.runtime_profile = renamed; f.save();
    assert.equal(git("check-ignore", "-q", "--", changed).status, 0);
    const before = missing ? null : fs.readFileSync(changed), draft = await f.backend.main({ action: "vanessa_read" });
    await assert.rejects(f.backend.main({ action: "vanessa_save", profile: { ...f.runtime, id: "changed" }, expectedRevision: draft.revision }), /отслеживается Git/);
    if (missing) assert.equal(fs.existsSync(changed), false);
    else assert.deepEqual(fs.readFileSync(changed), before);
  });

test("Git case checks preserve distinct existing files on a case-sensitive filesystem", async t => {
  const f = setup(t), directory = path.join(f.root, "case-sensitive"); fs.mkdirSync(directory);
  if (process.platform === "win32") {
    const k = createRequire(import.meta.url)(path.join(ROOT, "vendor/native", `win32_${process.arch}`, "koffi.node")), kernel = k.load("kernel32.dll");
    const create = kernel.func("void * __stdcall CreateFileW(str16 file, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, void *template)");
    const set = kernel.func("int __stdcall SetFileInformationByHandle(void *file, int kind, void *info, uint32_t size)");
    const close = kernel.func("int __stdcall CloseHandle(void *file)"), error = kernel.func("uint32_t __stdcall GetLastError()");
    const handle = create(directory, 0x001f01ff, 7, null, 3, 0x02000000, null);
    assert.ok(handle && BigInt.asIntN(64, k.address(handle)) !== -1n);
    let failure;
    try { const flags = Buffer.alloc(4); flags.writeUInt32LE(1); if (!set(handle, 23, flags, flags.length)) failure = error(); }
    finally { assert.ok(close(handle)); }
    if (failure) return t.skip(`per-directory case sensitivity is unavailable (${failure})`);
  }
  const file = path.join(directory, "vanessa.local.json"), other = path.join(directory, "VANESSA.LOCAL.JSON");
  fs.renameSync(f.file, file); f.profile.testing.vanessa_config.runtime_profile = "case-sensitive/vanessa.local.json"; f.save();
  try { fs.writeFileSync(other, "tracked control", { flag: "wx" }); }
  catch (error) { if (error.code === "EEXIST") return t.skip("the fixture filesystem is case-insensitive"); throw error; }
  const git = (...args) => spawnSync("git", ["-C", f.root, ...args], { windowsHide: true, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("config", "core.ignorecase", "false").status, 0);
  fs.writeFileSync(path.join(f.root, ".gitignore"), "*.json\n");
  assert.equal(git("add", "-f", "--", other).status, 0);
  const draft = await f.backend.main({ action: "vanessa_read" }); draft.profile.id = "changed";
  assert.equal((await f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision })).status, "saved");
  fs.unlinkSync(file);
  const missing = await f.backend.main({ action: "vanessa_read" });
  assert.equal((await f.backend.main({ action: "vanessa_save", profile: f.runtime, expectedRevision: missing.revision })).status, "saved");
  assert.equal(fs.readFileSync(other, "utf8"), "tracked control");
});

test("Git index failures prevent runtime credential writes", async t => {
  const f = setup(t), git = (...args) => spawnSync("git", ["-C", f.root, ...args], { windowsHide: true, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  fs.writeFileSync(path.join(f.root, ".gitignore"), "*.json\n");
  fs.writeFileSync(path.join(f.root, ".git", "index"), Buffer.alloc(32));
  const before = fs.readFileSync(f.file), draft = await f.backend.main({ action: "vanessa_read" }); draft.profile.id = "changed";
  await assert.rejects(f.backend.main({ action: "vanessa_save", profile: draft.profile, expectedRevision: draft.revision }), /проверить индекс Git/);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test("private file creation never replaces an existing file", t => {
  const f = fixture(t), file = path.join(f.base, "private.json");
  fs.writeFileSync(file, "original");
  const before = fs.readdirSync(f.base).sort();
  assert.throws(() => private_atomic_write(file, "replacement", false), { code: "EEXIST" });
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(f.base).sort(), before);
});

for (const replaceEntry of [false, true]) test(`Windows runtime profile creation and replacement use an owner-only DACL${replaceEntry ? " despite a parent-entry replacement attempt" : ""}`, { skip: process.platform !== "win32" }, async t => {
  const f = setup(t), k = createRequire(import.meta.url)(path.join(ROOT, "vendor/native", `win32_${process.arch}`, "koffi.node"));
  const adv = k.load("advapi32.dll"), kernel = k.load("kernel32.dll");
  const open = adv.func("int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)");
  const info = adv.func("int __stdcall GetTokenInformation(void *token, int kind, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *needed)");
  const sidText = adv.func("int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)");
  const descriptor = adv.func("int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ void **descriptor, void *size)");
  const set = adv.func("int __stdcall SetFileSecurityW(str16 file, uint32_t info, void *descriptor)");
  const get = adv.func("uint32_t __stdcall GetNamedSecurityInfoW(str16 file, int type, uint32_t info, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)");
  const aclInfo = adv.func("int __stdcall GetAclInformation(void *acl, _Out_ void *information, uint32_t size, int kind)");
  const aceAt = adv.func("int __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)");
  const equal = adv.func("int __stdcall EqualSid(void *left, void *right)");
  const current = kernel.func("void * __stdcall GetCurrentProcess()"), close = kernel.func("int __stdcall CloseHandle(void *handle)"), free = kernel.func("void * __stdcall LocalFree(void *pointer)");
  const token = [null], userBuffer = Buffer.alloc(4096), needed = [0], text = [null];
  assert.ok(open(current(), 8, token));
  try {
    assert.ok(info(token[0], 1, userBuffer, userBuffer.length, needed));
    const user = k.decode(userBuffer, "void *"); assert.ok(sidText(user, text));
    const sid = k.decode(text[0], "char16_t", -1);
    const broaden = (file, directory) => {
      const value = [null], inheritance = directory ? "OICI" : "";
      assert.ok(descriptor(`D:P(A;${inheritance};FA;;;${sid})(A;${inheritance};${replaceEntry ? "FA" : "FR"};;;BU)`, 1, value, null));
      try { assert.ok(set(file, 0x80000004, value[0])); } finally { free(value[0]); }
    };
    const assertOwnerOnly = file => {
      const owner = [null], acl = [null], value = [null];
      assert.equal(get(file, 1, 5, owner, null, acl, null, value), 0);
      try {
        assert.ok(equal(owner[0], user));
        const count = Buffer.alloc(12); assert.ok(aclInfo(acl[0], count, count.length, 2)); assert.equal(count.readUInt32LE(0), 1);
        const ace = [null]; assert.ok(aceAt(acl[0], 0, ace));
        const header = Buffer.from(k.decode(ace[0], "uint8_t", 4)), bytes = Buffer.from(k.decode(ace[0], "uint8_t", header.readUInt16LE(2)));
        assert.equal(bytes[0], 0); assert.equal(bytes[1] & 3, 0); assert.ok(equal(bytes.subarray(8), user));
      } finally { if (value[0]) free(value[0]); }
    };
    broaden(path.dirname(f.file), true); broaden(f.file, false);
    const parent = path.dirname(f.file), before = fs.readdirSync(parent).sort(), write = fs.writeFileSync;
    let attempts = 0;
    if (replaceEntry) t.mock.method(fs, "writeFileSync", (file, contents, ...args) => {
      if (typeof file === "string" && String(contents).includes("secret-9826") && file !== f.file) {
        // An actor with DELETE_CHILD on the project directory can replace its
        // entries, but cannot enter a private subdirectory. Try that interleaving
        // immediately before the writer puts any credentials on disk.
        const entry = path.relative(parent, file).split(path.sep)[0], temporary = path.join(parent, entry);
        assert.ok(entry && entry !== ".." && !path.isAbsolute(entry)); attempts++;
        const directory = fs.lstatSync(temporary).isDirectory();
        try {
          fs.renameSync(temporary, temporary + ".held");
          if (directory) fs.mkdirSync(temporary); else write(temporary, "", { flag: "wx" });
        } catch (error) { assert.ok(["EPERM", "EACCES", "EBUSY"].includes(error.code), error.message); }
      }
      return write(file, contents, ...args);
    });
    const existing = await f.backend.main({ action: "vanessa_read" }); existing.profile.id = "replaced";
    await f.backend.main({ action: "vanessa_save", profile: existing.profile, expectedRevision: existing.revision });
    assertOwnerOnly(f.file);
    fs.unlinkSync(f.file);
    const missing = await f.backend.main({ action: "vanessa_read" });
    await f.backend.main({ action: "vanessa_save", profile: f.runtime, expectedRevision: missing.revision });
    assertOwnerOnly(f.file);
    if (replaceEntry) assert.equal(attempts, 2);
    assert.deepEqual(fs.readdirSync(parent).sort(), before);
  } finally { if (text[0]) free(text[0]); close(token[0]); }
});

for (const phase of ["write", "publish"]) test(`private writer cleans up after a ${phase} failure`, t => {
  const f = fixture(t), file = path.join(f.base, "private.json"); fs.writeFileSync(file, "original");
  const before = fs.readdirSync(f.base).sort(), write = fs.writeFileSync, rename = fs.renameSync;
  if (phase === "write") t.mock.method(fs, "writeFileSync", (target, ...args) => {
    if (target !== file) throw new Error("simulated write failure");
    return write(target, ...args);
  });
  else t.mock.method(fs, "renameSync", (source, target) => {
    if (target === file) throw new Error("simulated publish failure");
    return rename(source, target);
  });
  assert.throws(() => private_atomic_write(file, "private test content"), new RegExp(`simulated ${phase} failure`));
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(f.base).sort(), before);
  rename(f.base, f.base + ".moved"); rename(f.base + ".moved", f.base);
});

test("manager launch preview is bound to the exact project and runtime bytes", async t => {
  const f = setup(t), prepared = await f.backend.main({ action: "vanessa_prepare" });
  assert.equal(prepared.target.project, f.profile.project.id);
  assert.equal(prepared.target.manager.database, "manager");
  assert.equal(JSON.stringify(prepared).includes("secret-9826"), false);
  const authorization = { scope: prepared.scope, effects: ["launch"], evidence: "Пользователь подтвердил запуск менеджера в тесте." };
  f.runtime.manager.user.password = "changed-secret"; f.saveRuntime();
  await assert.rejects(f.backend.main({ action: "vanessa_start", authorization, expectedRevision: prepared.revision }), /изменил/);
  const fresh = await f.backend.main({ action: "vanessa_prepare" });
  await assert.rejects(f.backend.main({ action: "vanessa_start", authorization: { ...authorization, effects: [] }, expectedRevision: fresh.revision }), /разрешение/);
  await assert.rejects(f.backend.main({ action: "vanessa_start", authorization, expectedRevision: fresh.revision }), /отличаются/);
});

test("manager start still requires workflow knowledge after setup routing", async t => {
  const f = setup(t);
  f.profile.knowledge = { mode: "kora", provider: "openviking", manifest: null, collections: ["architecture"], required: true, dependent_actions: [...WORKFLOW_ACTIONS] };
  f.save();
  const prepared = await f.backend.main({ action: "vanessa_prepare" });
  const authorization = { scope: prepared.scope, effects: ["launch"], evidence: "Пользователь подтвердил запуск менеджера в тесте." };
  await assert.rejects(f.backend.main({ action: "vanessa_start", authorization, expectedRevision: prepared.revision }), /Рабочий процесс заблокирован настройкой знаний/);
});

test("MCP returns runtime credentials only in app metadata and never in public content", async t => {
  const f = setup(t), client = await session(t, "mcp/settings.mjs", [], f);
  const result = await client.request("tools/call", { name: "settings.vanessa_read", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result._meta.data.profile.manager.user.password, "secret-9826");
  assert.equal(JSON.stringify({ content: result.content, structuredContent: result.structuredContent }).includes("secret-9826"), false);
});

test("MCP starts the approved scoped operation and reports a pre-launch missing platform", async t => {
  const f = setup(t), client = await session(t, "mcp/settings.mjs", [], f);
  const call = (name, args = {}) => client.request("tools/call", { name, arguments: args });
  const prepared = (await call("settings.vanessa_prepare"))._meta.data;
  const authorization = { scope: prepared.scope, effects: ["launch"], evidence: "Пользователь подтвердил показанную цель в тесте." };
  const started = await call("settings.vanessa_start", { authorization, expectedRevision: prepared.revision });
  assert.equal(started.structuredContent.action, "vanessa_start");
  let operation = started.structuredContent;
  for (let attempt = 0; attempt < 6 && operation.status === "running"; attempt++)
    operation = (await call("settings.operation", { operationId: operation.id, waitMs: 3000 })).structuredContent;
  assert.equal(operation.status, "failed");
  assert.match(operation.error, /ENOENT|файл|Windows/);
  assert.equal(JSON.stringify(operation).includes("secret-9826"), false);
  assert.equal(fs.existsSync(path.join(f.root, "1cv8c.exe")), false);
});
