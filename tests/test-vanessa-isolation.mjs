import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixture } from "./helpers.mjs";
import { loadProfile } from "../vanessa/profile.mjs";
import { clientControlKey, checkClaims, registryDir } from "../vanessa/runtime.mjs";

test("filesystem aliases cannot create independent Vanessa control identities", t => {
  const f = fixture(t), database = path.join(f.root, "database"), alias = path.join(f.root, "database-alias");
  fs.mkdirSync(database);
  fs.symlinkSync(database, alias, process.platform === "win32" ? "junction" : "dir");
  const profile = directory => ({ identity: "selected", mcp: { port: 12345 }, client: { infobase: { type: "file", path: directory } } });
  assert.equal(clientControlKey(profile(database)), clientControlKey(profile(alias)));
  t.mock.method(os, "tmpdir", () => f.state);
  fs.mkdirSync(registryDir(), { recursive: true });
  fs.writeFileSync(path.join(registryDir(), "endpoint-12346.owner.json"), JSON.stringify({
    profile: "another-profile", pid: process.pid, status: "running", clientKeyVersion: 3, client: clientControlKey(profile(database)),
  }));
  assert.throws(() => checkClaims(profile(alias)), /TestClient принадлежит активному менеджеру другого профиля/);
  const unsupported = JSON.stringify({ profile: "another-profile", pid: process.pid, status: "running", clientKeyVersion: 2, client: "unverified-old-key" });
  const ownerFile = path.join(registryDir(), "endpoint-12346.owner.json");
  fs.writeFileSync(ownerFile, unsupported);
  assert.throws(() => checkClaims(profile(alias)), /Неподдерживаемая запись владельца активного менеджера/);
  assert.equal(fs.readFileSync(ownerFile, "utf8"), unsupported);
});

test("the same Vanessa profile reached through a directory alias keeps its identity", t => {
  const f = fixture(t), profiles = path.join(f.root, "profiles"), alias = path.join(f.root, "profiles-alias");
  fs.mkdirSync(profiles);
  fs.symlinkSync(profiles, alias, process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(profiles, "runtime.json"), JSON.stringify({
    version: 1, id: "fixture", projectRoot: "..", platform: "platform", runtime: { epf: "runner.epf" },
    manager: { infobase: { type: "file", path: "database" }, user: { name: "manager", password: "secret", interface: "taxi" } },
    infobase: { type: "file", path: "database" }, users: { fixture: { name: "user", password: "secret", interface: "taxi" } },
    mcp: { url: "http://127.0.0.1:12345/mcp", port: 12345 }, features: "features", results: "results",
  }));
  const direct = loadProfile(path.join(profiles, "runtime.json")), indirect = loadProfile(path.join(alias, "runtime.json"));
  assert.equal(indirect.identity, direct.identity);
  assert.equal(indirect.file, direct.file);
  assert.equal(indirect.stateDir, direct.stateDir);
});
