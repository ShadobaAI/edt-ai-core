import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { edt_fixture as fixture } from "./helpers.mjs";
import { IndexObserverProxy } from "../scripts/index_observer_proxy.mjs";

test("an unused settings observer does not start a worker process", async t => {
  const f = fixture(t), spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected process"); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const observer = new IndexObserverProxy(f.state);
  await observer.close();
  assert.equal(spawn.mock.callCount(), 0);
});

test("a closed observer still reports an earlier unconfirmed cleanup", async t => {
  const f = fixture(t), observer = new IndexObserverProxy(f.state);
  const failure = Object.assign(new Error("cleanup was not confirmed"), { cleanupUnconfirmed: true, outcomeUnknown: true });
  observer.cleanupError = failure;
  await assert.rejects(observer.close(), error => error === failure);
});

test("closing a settings observer waits for its active observation", async t => {
  const f = fixture(t), observer = new IndexObserverProxy(f.state); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  t.mock.method(observer, "run", async () => { enter(); await gate; return { ok: true }; });
  const observation = observer.observe({}, f.root, {}, {}); await entered;
  let finished = false;
  const closing = observer.close().then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(finished, false);
  release(); assert.deepEqual(await observation, { ok: true }); await closing;
});
