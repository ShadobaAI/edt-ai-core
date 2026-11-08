import test from "node:test";
import assert from "node:assert/strict";
import { edt_fixture as fixture } from "./helpers.mjs";
import { IndexObserverProxy } from "../scripts/index_observer_proxy.mjs";

test("cancelling observer startup before any request leaves no cleanup barrier", { timeout: 20000 }, async t => {
  const f = fixture(t), proxy = new IndexObserverProxy(f.state);
  const starting = proxy.start().then(() => null, error => error);
  await proxy.close();
  assert.match((await starting).message, /закрывается/);
  assert.equal(proxy.cleanupError, null);
});

test("a closed observer still reports an earlier unconfirmed cleanup", async t => {
  const f = fixture(t), proxy = new IndexObserverProxy(f.state);
  const failure = Object.assign(new Error("cleanup was not confirmed"), { cleanupUnconfirmed: true, outcomeUnknown: true });
  proxy.cleanupError = failure;
  proxy.closedConfirmed = true;
  proxy.socket = { destroy() {} };
  await assert.rejects(proxy.close(), error => error === failure);
});

test("an unresponsive observer cannot hang direct cleanup or hide its pending request", async t => {
  const f = fixture(t), proxy = new IndexObserverProxy(f.state);
  let destroyed = false;
  proxy.socket = { write() {}, destroy() { destroyed = true; } };
  proxy.dispatched = true;
  const observation = new Promise((resolve, reject) => proxy.pending.set(1, { resolve, reject }));
  const rejectedObservation = assert.rejects(observation, error => error.cleanupUnconfirmed && error.outcomeUnknown);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const closed = assert.rejects(proxy.close(), error => error.cleanupUnconfirmed && error.outcomeUnknown);
  t.mock.timers.tick(12000);
  await Promise.all([closed, rejectedObservation]);
  assert.equal(destroyed, true);
  assert.ok(proxy.cleanupError);
});
