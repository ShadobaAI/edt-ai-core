import net from "node:net";
import fs from "node:fs";

const leaseTimeout = 5000;
const unconfirmed = () => Object.assign(new Error("Завершение владельца читателя не подтверждено."), { outcomeUnknown: true });

function listenServer(server, address) {
  return new Promise((resolve, reject) => {
    let settled = false, timedOut = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); server.removeListener("error", onError);
      error ? reject(error) : resolve();
    };
    const onError = error => finish(error);
    const timer = setTimeout(() => {
      timedOut = true;
      // If the bind completes after this timeout it must not resurrect the
      // lease or let the original operation continue.
      server.on("error", () => {});
      try { server.unref(); server.close(() => {}); } catch { /* Completion remains unconfirmed. */ }
      finish(unconfirmed());
    }, leaseTimeout);
    server.once("error", onError);
    try {
      server.listen(address, () => {
        if (timedOut) { try { server.unref(); server.close(() => {}); } catch {} return; }
        finish();
      });
    } catch (error) { finish(error); }
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => { try { server.unref(); } catch {} finish(unconfirmed()); }, leaseTimeout);
    try { server.close(finish); } catch (error) { finish(error); }
  });
}

function endpoint(id, observer = false) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id || ""))
    throw new Error("Неподдерживаемая запись читателя индекса; проверьте владельца записи");
  // A short pathname fits macOS sockaddr_un even with a long project/state path.
  const name = "1c-ai-core-reader-" + id + (observer ? "-observe" : "");
  return process.platform === "win32" ? "\\\\.\\pipe\\" + name : "/tmp/" + name + ".sock";
}
export async function open_reader(id, { binding, observe } = {}) {
  let serverFailure;
  const address = endpoint(id), server = net.createServer(socket => {
    socket.on("error", () => {});
    const deadline = setTimeout(() => socket.destroy(), 1000);
    socket.once("close", () => clearTimeout(deadline));
    if (serverFailure) return socket.destroy();
    socket.end(id);
  });
  server.maxConnections = 8;
  await listenServer(server, address);
  server.on("error", error => { serverFailure = error; });
  let observerServer, closing;
  const sockets = new Set();
  const close = () => closing ||= (async () => {
    for (const socket of sockets) socket.destroy();
    const results = await Promise.allSettled([closeServer(observerServer), closeServer(server)]);
    const failed = results.find(item => item.status === "rejected");
    if (failed) throw failed.reason;
    if (serverFailure) throw serverFailure;
  })();
  try {
    if (process.platform !== "win32") fs.chmodSync(address, 0o600);
    server.unref();
    if (observe) {
      const observerAddress = endpoint(id, true);
      let sharedObservation = null;
      observerServer = net.createServer(socket => {
        sockets.add(socket); socket.on("error", () => {});
        const deadline = setTimeout(() => socket.destroy(), 30000);
        socket.once("close", () => { clearTimeout(deadline); sockets.delete(socket); sharedObservation?.interested.delete(socket); });
        let input = "";
        socket.setEncoding("utf8");
        socket.on("data", chunk => {
          input += chunk;
          if (input.length > 512) return socket.destroy();
          const newline = input.indexOf("\n");
          if (newline < 0) return;
          socket.removeAllListeners("data");
          let request; try { request = JSON.parse(input.slice(0, newline)); } catch { return socket.destroy(); }
          if (request?.id !== id || request?.binding !== binding || request?.action !== "health") return socket.destroy();
          if (!sharedObservation) {
            const flight = { interested: new Set() };
            flight.promise = Promise.resolve().then(() => observe(() => flight.interested.size === 0))
              .finally(() => { if (sharedObservation === flight) sharedObservation = null; });
            sharedObservation = flight;
          }
          sharedObservation.interested.add(socket);
          sharedObservation.promise.then(
            result => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, result }) + "\n"); },
            error => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, closing: Boolean(error.ownerClosing), inputsChanged: Boolean(error.inputsChanged), outcomeUnknown: Boolean(error.outcomeUnknown) }) + "\n"); },
          );
        });
      });
      observerServer.maxConnections = 8;
      await listenServer(observerServer, observerAddress);
      observerServer.on("error", error => { serverFailure = error; });
      if (process.platform !== "win32") fs.chmodSync(observerAddress, 0o600);
      observerServer.unref();
    }
    return { close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw Object.assign(new Error("Не подтверждено закрытие владельца читателя индекса."), { outcomeUnknown: true, cause: cleanup }); }
    throw error;
  }
}

// This endpoint exposes one operation only: a fresh health observation for the
// exact pre-validated binding. It never accepts configuration or tool names.
export function observe_reader(id, binding) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint(id, true)); let input = "", finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Истекло время ожидания владельца читателя индекса.")), 30000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ id, binding, action: "health" }) + "\n"));
    socket.on("data", chunk => {
      input += chunk;
      if (input.length > 1024 * 1024) return finish(new Error("Ответ читателя индекса слишком велик."));
      const newline = input.indexOf("\n"); if (newline < 0) return;
      let message; try { message = JSON.parse(input.slice(0, newline)); } catch { return finish(new Error("Некорректный ответ читателя индекса.")); }
      if (message?.ok === true && message.result && typeof message.result === "object") finish(null, message.result);
      else finish(Object.assign(new Error("Владелец не подтвердил состояние индекса."), { ownerResponded: true, ownerClosing: message?.closing === true, inputsChanged: message?.inputsChanged === true, outcomeUnknown: message?.outcomeUnknown === true }));
    });
    socket.once("error", error => finish(error));
    socket.once("end", () => finish(new Error("Владелец читателя индекса закрыл соединение без результата.")));
  });
}
export function reader_active(id, { timeoutMs = 2000, cleanupStale = true } = {}) {
  const address = endpoint(id);
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    let received = "", timer, finished = false;
    const finish = (error, active) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(active);
    };
    timer = setTimeout(() => finish(new Error("Не удалось подтвердить владельца читателя индекса; обслуживание заблокировано")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      received += chunk;
      if (received.length > id.length) finish(new Error("Некорректный ответ владельца читателя индекса"));
    });
    socket.once("end", () => finish(received === id ? null : new Error("Идентичность владельца читателя индекса не подтверждена"), true));
    socket.once("error", error => {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) return finish(error);
      // A dead Unix listener can leave its socket inode. Its unique name is
      // never reused by a new lease, so removing it cannot affect a live owner.
      if (cleanupStale && process.platform !== "win32") {
        for (const stale of [address, endpoint(id, true)]) {
          try { fs.unlinkSync(stale); } catch (cleanup) { if (cleanup.code !== "ENOENT") return finish(cleanup); }
        }
      }
      finish(null, false);
    });
  });
}
