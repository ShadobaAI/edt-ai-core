import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import path from "node:path";
import { PassThrough } from "node:stream";
import { read_frames, DEFAULT_MAX_BYTES } from "../scripts/mcp_codec.mjs";
import { ROOT, fixture, node } from "./helpers.mjs";

test("frame limits apply before decoding, across fragments and within multi-frame chunks", () => {
  const stream = new PassThrough(), frames = [], errors = [];
  read_frames(stream, frame => frames.push(frame), error => errors.push(error), 4);
  stream.write(Buffer.from("a\n"));
  stream.write(Buffer.from("\u044f"));
  stream.write(Buffer.from("\u044f\nnext\n12345\nignored\n"));
  stream.end();
  assert.deepEqual(frames, ["a", "\u044f\u044f", "next"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /budget/);
});

test("stream errors and truncated frames fail once without dispatching a partial request", () => {
  for (const interrupted of [false, true]) {
    const stream = new PassThrough(), frames = [], errors = [];
    read_frames(stream, frame => frames.push(frame), error => errors.push(error));
    stream.write('{"jsonrpc":');
    if (interrupted) stream.emit("error", new Error("fixture read failure"));
    stream.emit("end");
    stream.write("ignored\n");
    assert.deepEqual(frames, []);
    assert.equal(errors.length, 1);
    stream.destroy();
  }
});

test("tiny fragments cannot amplify a bounded frame into unbounded object retention", () => {
  const codec = pathToFileURL(path.join(ROOT, "scripts/mcp_codec.mjs")).href;
  const code = `
    import { PassThrough } from 'node:stream';
    import { read_frames } from ${JSON.stringify(codec)};
    const stream = new PassThrough(), frames = [];
    read_frames(stream, frame => frames.push(frame.length), error => { throw error; }, 1024 * 1024);
    global.gc();
    const before = process.memoryUsage();
    for (let i = 0; i < 200000; i++) stream.write('x');
    global.gc(); global.gc();
    const after = process.memoryUsage();
    const retained = after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers;
    stream.end('\\n');
    console.log(JSON.stringify({ retained, frames }));
  `;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", code], {
    encoding: "utf8", windowsHide: true, timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { retained, frames } = JSON.parse(result.stdout);
  assert.deepEqual(frames, [200000]);
  assert.ok(retained < 8 * 1024 * 1024, `tiny fragments retained ${retained} bytes`);
});

for (const file of ["mcp/settings.mjs", "policy/read-only-mcp.mjs"]) {
  test(`${file} rejects oversized input and never echoes malformed JSON`, t => {
    const f = fixture(t), secret = "invalid-json-sensitive-value";
    const malformed = node(file, [], { env: f.env, input: `{"secret":"${secret}",invalid}\n` });
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.equal(JSON.parse(malformed.stdout).error.code, -32700);
    assert.ok(!(malformed.stdout + malformed.stderr).includes(secret));
    const oversized = node(file, [], { env: f.env, input: "x".repeat(DEFAULT_MAX_BYTES + 1) + '\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n' });
    assert.equal(oversized.status, 1, oversized.stderr);
    const responses = oversized.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].error.code, -32600);
    assert.equal(oversized.stderr, "");
  });
}

test("session discovery never repeats malformed hook input in its context or diagnostics", t => {
  const f = fixture(t), secret = "hook-input-sensitive-value";
  const result = node("hooks/session-start.mjs", [], { env: f.env, input: `{"secret":"${secret}",invalid}` });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).hookSpecificOutput.additionalContext.includes("profile discovery failed"));
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

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
