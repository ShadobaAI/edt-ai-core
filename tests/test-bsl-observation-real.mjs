import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { edt_fixture as fixture, environment, ROOT } from "./helpers.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";
import { which } from "../scripts/processes.mjs";
import { native_environment } from "../scripts/components.mjs";

function isolated_environment(f) {
  const home = path.join(f.base, "home"), tmp = path.join(f.base, "tmp");
  fs.mkdirSync(home); fs.mkdirSync(tmp);
  const env = { ...f.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMP: tmp, TEMP: tmp, TMPDIR: tmp,
    JAVA_TOOL_OPTIONS: `-Duser.home="${home}" -Djava.io.tmpdir="${tmp}"` };
  delete env._JAVA_OPTIONS; delete env.JDK_JAVA_OPTIONS;
  return native_environment(null, env);
}

// Explicit opt-in: only read an existing JAR and use isolated test projects.
test("real BSL LS exposes its API with an isolated explicit configuration", { skip: !process.env.EDT_AI_TEST_REAL_BSL_JAR, timeout: 90000 }, async t => {
  const jar = process.env.EDT_AI_TEST_REAL_BSL_JAR, java = which("java");
  assert.ok(java && path.isAbsolute(jar) && fs.statSync(jar).isFile());
  const f = fixture(t); environment(t, f.env); f.save();
  const config = path.join(f.root, "bsl-test.json"); fs.writeFileSync(config, '{"language":"en","sendErrors":"never"}');
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/bsl-ls-proxy.mjs"),
    "--project-root", f.root, "--java", java, "--jar", jar, "--configuration", config], f.root, isolated_environment(f), 60, { readerJob: randomUUID() });
  try {
    const init = await client.initialize(), catalogue = await client.request("tools/list");
    assert.ok(init.serverInfo?.name); assert.ok(catalogue.tools.some(item => item.name === "register_workspace_folder"));
    if (process.env.EDT_AI_TEST_BSL_TRACE) process.stderr.write("fixture tools: " + catalogue.tools.map(item => item.name).join(", ") + "\n");
  } finally { await client.close({ grace: 0 }); }
});

test("real BSL LS MCP availability alone does not prove the explicit JSON was accepted", { skip: !process.env.EDT_AI_TEST_REAL_BSL_JAR, timeout: 90000 }, async t => {
  const jar = process.env.EDT_AI_TEST_REAL_BSL_JAR, java = which("java");
  assert.ok(java && path.isAbsolute(jar) && fs.statSync(jar).isFile());
  const f = fixture(t); environment(t, f.env); f.save();
  const config = path.join(f.root, "bsl-invalid.json"); fs.writeFileSync(config, '{"language":');
  const client = new McpClient([process.execPath, path.join(ROOT, "mcp/bsl-ls-proxy.mjs"),
    "--project-root", f.root, "--java", java, "--jar", jar, "--configuration", config], f.root, isolated_environment(f), 60, { readerJob: randomUUID() });
  try {
    const init = await client.initialize(), catalogue = await client.request("tools/list");
    assert.ok(init.serverInfo?.name); assert.ok(catalogue.tools.some(item => item.name === "register_workspace_folder"));
  }
  finally { await client.close({ grace: 0 }); }
});
