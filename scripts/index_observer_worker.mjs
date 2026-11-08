import net from "node:net";
import { read_frames } from "./mcp_codec.mjs";
import { IndexObserver } from "./runtime.mjs";

// This process intentionally outlives the settings session long enough to
// close its own reader and verify the complete native process tree. It accepts
// only requests from the session which created the private channel.
const address = process.env.EDT_AI_OBSERVER_ADDRESS;
const token = process.env.EDT_AI_OBSERVER_TOKEN;
const state = process.env.EDT_AI_STATE_DIR;
delete process.env.EDT_AI_OBSERVER_ADDRESS;
delete process.env.EDT_AI_OBSERVER_TOKEN;
if (!address || !/^[a-f0-9]{64}$/.test(token || "") || !state) process.exit(1);

const observer = new IndexObserver(state);
const socket = net.connect(process.platform === "linux" && address.startsWith("@") ? "\0" + address.slice(1) : address);
let accepted = false, shutting = null;
const send = message => { if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n"); };
const shutdown = () => {
  if (shutting) return shutting;
  send({ type: "closing" });
  return shutting = (async () => {
    try {
      await observer.close();
      if (!socket.destroyed) socket.end(JSON.stringify({ type: "closed" }) + "\n");
    } catch (error) {
      if (!socket.destroyed) socket.end(JSON.stringify({ type: "cleanup_failed", message: error.message }) + "\n");
      process.exitCode = 1;
    }
  })();
};
socket.once("connect", () => send({ type: "hello", token }));
socket.once("error", () => { void shutdown(); });
socket.once("close", () => { void shutdown(); });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void shutdown(); });
read_frames(socket, line => {
  let message;
  try { message = JSON.parse(line); } catch { socket.destroy(); return; }
  if (!accepted) {
    if (message?.type !== "accepted") return socket.destroy();
    accepted = true;
    return;
  }
  if (message?.type === "close") { void shutdown(); return; }
  if (message?.type !== "observe" || !Number.isSafeInteger(message.id)) return socket.destroy();
  if (shutting) return send({ type: "error", id: message.id, message: "Сеанс наблюдения индекса закрывается.", inputsChanged: true });
  void observer.observe(message.config, message.root, message.profile, message.snapshot).then(
    result => send({ type: "result", id: message.id, result }),
    error => send({ type: "error", id: message.id, message: error.message, code: error.code,
      inputsChanged: error.inputsChanged === true, outcomeUnknown: error.outcomeUnknown === true,
      cleanupUnconfirmed: error.cleanupUnconfirmed === true || Boolean(observer.cleanupError), remote: error.remote === true }),
  );
}, () => socket.destroy());
