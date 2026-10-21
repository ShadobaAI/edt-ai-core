import assert from "node:assert/strict";
import test from "node:test";
import { fixture, session } from "./helpers.mjs";
const preload = new URL("./fixtures/managed-spawn.mjs", import.meta.url).href;
test("managed stdio relay preserves schemas/results and refreshes discovery only at boundaries", async (t) => {
  const f = fixture(t);
  f.save();
  const client = await session(
    t,
    "scripts/lazy_mcp.mjs",
    ["--component", "code-index"],
    f,
    {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import " + preload]
        .filter(Boolean)
        .join(" "),
    },
  );
  const tools = (await client.request("tools/list")).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["inspect", "tail"],
  );
  assert.equal(tools[0].inputSchema.properties.change.type, "boolean");
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[0].outputSchema.type, "object");
  const before = (await client.call("inspect", {})).structuredContent;
  for (let i = 0; i < 3; i++)
    assert.deepEqual(
      (await client.call("inspect", {})).structuredContent,
      before,
    );
  assert.equal(before.rows_elided_already_delivered, 3);
  assert.equal(before.response_sections_omitted, true);
  await client.call("inspect", { change: true });
  const refreshed = (await client.call("inspect", {})).structuredContent;
  assert.equal(refreshed.discoveries, before.discoveries + 2);
  assert.ok(
    (await client.request("tools/list")).tools.some(
      (tool) => tool.name === "later",
    ),
  );
});
test("managed BSL binding fails closed on a lifecycle-incompatible native catalogue", async (t) => {
  const f = fixture(t);
  f.save();
  const client = await session(
    t,
    "scripts/lazy_mcp.mjs",
    ["--component", "bsl-ls"],
    f,
    {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import " + preload]
        .filter(Boolean)
        .join(" "),
    },
  );
  const status = (await client.call("core_runtime_status", {}))
    .structuredContent;
  assert.equal(status.ready, false);
  assert.match(status.detail, /native multi-workspace API/);
  assert.deepEqual(
    (await client.request("tools/list")).tools.map((tool) => tool.name),
    ["core_runtime_status"],
  );
});
