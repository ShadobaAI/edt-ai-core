import net from "node:net";
import fs from "node:fs";

function endpoint(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id || ""))
    throw new Error("Неподдерживаемая запись читателя индекса; проверьте владельца записи");
  // A short pathname fits macOS sockaddr_un even with a long project/state path.
  return process.platform === "win32" ? "\\\\.\\pipe\\1c-ai-core-reader-" + id : "/tmp/1c-ai-core-reader-" + id + ".sock";
}
export async function open_reader(id) {
  let serverFailure;
  const address = endpoint(id), server = net.createServer(socket => {
    socket.on("error", () => {});
    const deadline = setTimeout(() => socket.destroy(), 1000);
    socket.once("close", () => clearTimeout(deadline));
    if (serverFailure) return socket.destroy();
    socket.end(id);
  });
  server.maxConnections = 8;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => { server.removeListener("error", reject); resolve(); });
  });
  server.on("error", error => { serverFailure = error; });
  let closing;
  const close = () => closing ||= new Promise((resolve, reject) => server.close(error => error || serverFailure ? reject(error || serverFailure) : resolve()));
  try {
    if (process.platform !== "win32") fs.chmodSync(address, 0o600);
    server.unref();
    return { close };
  } catch (error) { await close(); throw error; }
}
export function reader_active(id) {
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
    timer = setTimeout(() => finish(new Error("Не удалось подтвердить владельца читателя индекса; обслуживание заблокировано")), 2000);
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
      if (process.platform !== "win32") {
        try { fs.unlinkSync(address); } catch (cleanup) { if (cleanup.code !== "ENOENT") return finish(cleanup); }
      }
      finish(null, false);
    });
  });
}
