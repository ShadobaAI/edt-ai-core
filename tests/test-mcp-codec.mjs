import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

test("decoded messages release their backing buffers while retaining a partial next message", () => {
  const codec = pathToFileURL(path.join(ROOT, "scripts/mcp_codec.mjs")).href;
  const code = `
    import { PassThrough } from 'node:stream';
    import { read_lines } from ${JSON.stringify(codec)};
    const streams = [new PassThrough(), new PassThrough()], received = [];
    for (const stream of streams) read_lines(stream, message => received.push(message.id), error => { throw error; });
    global.gc();
    const before = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < streams.length; i++) {
      const line = JSON.stringify({ jsonrpc: '2.0', id: i, result: { text: 'x'.repeat(12 * 1024 * 1024) } }) + '\\n';
      streams[i].write(Buffer.from(line + (i ? '{"jsonrpc":' : '')));
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    global.gc(); global.gc();
    const retained = process.memoryUsage().arrayBuffers - before;
    streams[1].write('"2.0","id":3,"result":{}}\\n');
    for (const stream of streams) stream.destroy();
    console.log(JSON.stringify({ retained, received }));
  `;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", code], {
    encoding: "utf8", windowsHide: true, timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { retained, received } = JSON.parse(result.stdout);
  assert.deepEqual(received, [0, 1, 3]);
  assert.ok(retained < 4 * 1024 * 1024, `decoded buffers retained ${retained} bytes`);
});
