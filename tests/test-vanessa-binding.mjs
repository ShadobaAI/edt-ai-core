import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, node, success } from "./helpers.mjs";
import { runtime_profile } from "../scripts/vanessa.mjs";
import { sha256 } from "../scripts/project_paths.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { launch, stop_child } from "../scripts/processes.mjs";
import { ROOT } from "./helpers.mjs";
import { WORKFLOW_ACTIONS } from "../scripts/knowledge.mjs";
function binding(t) {
  const f = fixture(t),
    file = path.join(f.root, ".ai/vanessa.local.json");
  f.profile.testing.vanessa = true;
  f.profile.testing.vanessa_config = {
    repository_id: "product",
    runtime_profile: ".ai/vanessa.local.json",
    features: "features",
    results: "results",
    server_name: "vanessa",
  };
  const raw = {
    version: 1,
    id: "fixture",
    projectRoot: f.root,
    platform: path.join(f.root, "never-start.exe"),
    runtime: { epf: path.join(f.root, "fixture.epf") },
    manager: { infobase: { type: "file", path: path.join(f.root, "manager") } },
    client: {
      name: "TestClient",
      infobase: { type: "file", path: path.join(f.root, "client") },
    },
    mcp: {
      serverName: "vanessa",
      url: "http://127.0.0.1:19876/mcp",
      port: 19876,
    },
    features: path.join(f.root, "features"),
    results: path.join(f.root, "results"),
  };
  const save = () => {
    f.save();
    fs.writeFileSync(file, JSON.stringify(raw));
  };
  save();
  const invoke = (command, args = [], options = {}) =>
    node("scripts/vanessa.mjs", [command, "--project-root", f.root, ...args], {
      env: f.env,
      ...options,
    });
  return { ...f, file, raw, save, invoke };
}
test("KORA blocks Vanessa workflow before connecting or launching", t => {
  const f = binding(t);
  f.profile.knowledge = { mode: "kora", provider: "openviking", manifest: null, collections: ["architecture"], required: true, dependent_actions: [...WORKFLOW_ACTIONS] };
  f.save();
  for (const command of ["list", "connect", "start", "run", "call"]) {
    const result = f.invoke(command);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Knowledge workflow blocked/, command);
  }
});

test("Vanessa wrapper rejects disabled and mismatched bindings before launching anything", (t) => {
  const f = binding(t);
  f.profile.testing.vanessa = false;
  f.save();
  assert.throws(() => runtime_profile(f.root), /disabled/);
  f.profile.testing.vanessa = true;
  f.raw.features = f.base;
  f.save();
  assert.throws(() => runtime_profile(f.root), /differs/);
});
test("Vanessa describe preserves Unicode and binds exact canonical targets and runtime bytes", (t) => {
  const f = binding(t),
    response = success(
      f.invoke("describe", [
        "--feature",
        "features/测试.feature",
        "--scenario",
        "Проверка 🧪",
      ]),
    ),
    scope = JSON.parse(response.scope);
  assert.ok(response.scope.includes("Проверка 🧪"));
  assert.equal(scope.runtime, sha256(fs.readFileSync(f.file)));
  assert.equal(scope.projectRoot, f.root);
  assert.equal(scope.feature, "features/测试.feature");
});
for (const feature of ["features/smoke.feature", ".local/repair.feature"])
  test(
    "configured/temporary feature has a precise run agreement gate: " + feature,
    (t) => {
      const f = binding(t),
        args = [
          "--feature",
          feature,
          "--scenario",
          "Exact scenario",
          "--editor-transition",
        ];
      const request = success(f.invoke("describe", args));
      assert.equal(JSON.parse(request.scope).feature, feature);
      const result = f.invoke("run", args);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /agreement required/);
      assert.ok(!fs.existsSync(path.join(f.root, "results")));
    },
  );
test("Vanessa start requires actual agreement and changed targets invalidate old authorization", (t) => {
  const f = binding(t);
  assert.match(f.invoke("start").stdout, /agreement required/);
  const request = success(f.invoke("describe", ["--for-action", "start"]));
  delete request.runtimeProfile;
  request.authorizations = [
    {
      scope: request.scope,
      effects: request.effects,
      evidence: "synthetic actual user instruction",
    },
  ];
  const approval = path.join(f.base, "approval.json");
  fs.writeFileSync(approval, JSON.stringify(request));
  f.raw.client.infobase.path = path.join(f.root, "other-client");
  f.save();
  const result = f.invoke("start", ["--authorization-file", approval]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /scope\/effects differ/);
});
test("Vanessa outside paths, non-feature suffix and missing exact scenario are rejected before policy", (t) => {
  const f = binding(t);
  for (const command of ["describe", "run"])
    for (const feature of [
      path.join(f.base, "outside.feature"),
      "../outside.feature",
      ".local/repair.txt",
    ]) {
      const result = f.invoke(command, [
        "--feature",
        feature,
        "--scenario",
        "Exact",
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /Feature must remain|Path escapes/);
    }
});
test("relative tool arguments hash binds caller bytes and generic calls require an explicit record", (t) => {
  const f = binding(t),
    caller = path.join(f.root, "caller");
  fs.mkdirSync(caller);
  fs.writeFileSync(
    path.join(caller, "arguments.json"),
    '{"marker":"authorized"}',
  );
  fs.writeFileSync(path.join(f.root, "arguments.json"), '{"marker":"other"}');
  const args = [
    "--for-action",
    "call",
    "--tool",
    "get_test_results",
    "--arguments-file",
    "arguments.json",
  ];
  const response = success(f.invoke("describe", args, { cwd: caller }));
  assert.equal(
    JSON.parse(response.scope).argumentsHash,
    sha256(fs.readFileSync(path.join(caller, "arguments.json"))),
  );
  const result = f.invoke("call", args, { cwd: caller });
  assert.match(result.stdout, /explicit effects\/authorization/);
});
test("identical relative runtime files in distinct clones cannot share authorization", (t) => {
  const f = binding(t);
  f.raw.projectRoot = "..";
  f.raw.features = "../features";
  f.raw.results = "../results";
  f.raw.manager.infobase.path = "../manager";
  f.raw.client.infobase.path = "../client";
  f.save();
  const request = success(f.invoke("describe", ["--for-action", "start"]));
  delete request.runtimeProfile;
  request.authorizations = [
    {
      scope: request.scope,
      effects: request.effects,
      evidence: "only original clone",
    },
  ];
  const approval = path.join(f.base, "approval.json");
  fs.writeFileSync(approval, JSON.stringify(request));
  const clone = path.join(f.base, "clone");
  // Use JS traversal for Unicode paths on Node 22/Windows (nodejs/node#61950).
  fs.cpSync(f.root, clone, { recursive: true, filter: () => true });
  const result = node(
    "scripts/vanessa.mjs",
    ["start", "--project-root", clone, "--authorization-file", approval],
    { env: f.env },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /scope\/effects differ/);
});
test("authorized generic call resolves relative argument bytes before changing to the project directory", async (t) => {
  const f = binding(t),
    calls = [],
    server = createServer(async (req, res) => {
      if (req.method === "DELETE") return res.writeHead(204).end();
      let text = "";
      for await (const chunk of req) text += chunk;
      const message = JSON.parse(text);
      if (message.method === "notifications/initialized")
        return res.writeHead(202).end();
      let result = {};
      if (message.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "own-loopback", version: "1" },
          capabilities: { tools: {} },
        };
      if (message.method === "tools/list")
        result = {
          tools: [
            {
              name: "get_test_results",
              inputSchema: {
                type: "object",
                properties: { marker: { type: "string" } },
                required: ["marker"],
                additionalProperties: false,
              },
            },
          ],
        };
      if (message.method === "tools/call") {
        calls.push(message.params);
        result = {
          content: [{ type: "text", text: "synthetic read-only result" }],
        };
      }
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  const port = server.address().port;
  Object.assign(f.raw.mcp, { port, url: `http://127.0.0.1:${port}/mcp` });
  f.save();
  const caller = path.join(f.root, "caller"),
    isolated = path.join(f.base, "isolated");
  fs.mkdirSync(caller);
  fs.mkdirSync(isolated);
  fs.writeFileSync(
    path.join(caller, "arguments.json"),
    '{"marker":"authorized"}',
  );
  fs.writeFileSync(
    path.join(f.root, "arguments.json"),
    '{"marker":"different"}',
  );
  const args = [
      "--tool",
      "get_test_results",
      "--arguments-file",
      "arguments.json",
    ],
    request = success(
      f.invoke("describe", ["--for-action", "call", ...args], { cwd: caller }),
    );
  delete request.runtimeProfile;
  request.authorizations = [];
  const approval = path.join(f.base, "approval.json");
  fs.writeFileSync(approval, JSON.stringify(request));
  const child = launch(
    process.execPath,
    [
      path.join(ROOT, "scripts/vanessa.mjs"),
      "call",
      "--project-root",
      f.root,
      ...args,
      "--authorization-file",
      approval,
    ],
    {
      cwd: caller,
      env: { ...f.env, TEMP: isolated, TMP: isolated },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  f.clients.push({ close: () => stop_child(child, 0) });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const [code] = await once(child, "close");
  assert.equal(code, 0, output);
  assert.deepEqual(calls, [
    { name: "get_test_results", arguments: { marker: "authorized" } },
  ]);
});
