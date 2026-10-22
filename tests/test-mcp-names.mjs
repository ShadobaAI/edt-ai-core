import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, ROOT } from "./helpers.mjs";
import { McpClient } from "../scripts/mcp_client.mjs";

test("all manifest MCP names and advertised server titles use lowercase", async t => {
  const f=fixture(t),manifest=JSON.parse(fs.readFileSync(path.join(ROOT,"mcp.json"),"utf8"));
  for(const [name,entry] of Object.entries(manifest.mcpServers)){
    assert.equal(name,name.toLowerCase());
    const args=entry.args.map(value=>value.replaceAll("${PLUGIN_ROOT}",ROOT));
    const client=new McpClient([process.execPath,...args],f.root,f.env,10);f.clients.push(client);
    const initialized=await client.initialize();
    assert.equal(initialized.serverInfo.title,name);
    assert.equal(initialized.serverInfo.name,initialized.serverInfo.name.toLowerCase());
    if(name==="1c-ai-settings"){
      const discovery=await client.request("server/discover");
      assert.equal(discovery._meta["io.modelcontextprotocol/serverInfo"].title,name);
    }
  }
  assert.equal(fs.existsSync(path.join(f.state,"runtime-lock.json")),false);
});
