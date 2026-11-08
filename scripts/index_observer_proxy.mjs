import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { read_frames } from "./mcp_codec.mjs";
import { spawn_detached_windows } from "./windows_process.mjs";

const uncertain = message => Object.assign(new Error(message), { outcomeUnknown: true, cleanupUnconfirmed: true });

// The observer owns its reader in a separate process. If this session is
// interrupted the channel closes, but the observer remains alive to reap its
// protected children before releasing the project-wide reader lease.
export class IndexObserverProxy {
  constructor(state) {
    this.state = state;
    this.pending = new Map();
    this.sequence = 0;
    this.socket = null;
    this.starting = null;
    this.closing = null;
    this.cleanupError = null;
  }
  async start() {
    if (this.closing) throw uncertain("Сеанс наблюдения индекса закрывается.");
    if (this.cleanupError) throw this.cleanupError;
    if (this.socket && (this.closedConfirmed || this.workerClosing)) {
      const previous = this.socket;
      await new Promise(resolve => { previous.once("close", resolve); if (this.closedConfirmed) previous.destroy(); });
    }
    if (this.cleanupError) throw this.cleanupError;
    if (this.socket) return;
    if (this.starting) return this.starting;
    this.starting = this.startWorker();
    try { await this.starting; } finally { this.starting = null; }
  }
  async startWorker() {
    this.closedConfirmed = false;
    this.workerClosing = false;
    this.dispatched = false;
    const id = randomUUID(), token = randomBytes(32).toString("hex");
    const name = "1c-ai-core-observer-" + id;
    // Linux abstract sockets disappear with the listener even after a crash.
    // The random token still authenticates the peer before project data flows.
    const address = process.platform === "win32" ? "\\\\.\\pipe\\" + name : process.platform === "linux" ? "@" + name : "/tmp/" + name + ".sock";
    const listenAddress = process.platform === "linux" ? "\0" + address.slice(1) : address;
    const server = net.createServer();
    server.maxConnections = 8;
    let worker, timer, settled = false, committed = false;
    const connection = new Promise((resolve, reject) => {
      const fail = error => { if (!settled) { settled = true; reject(error); } };
      timer = setTimeout(() => fail(new Error("Не удалось запустить наблюдатель индекса.")), 10000);
      server.once("error", fail);
      server.on("connection", socket => {
        let authenticated = false;
        const handshake = setTimeout(() => { if (!authenticated) socket.destroy(); }, 3000);
        socket.once("error", () => socket.destroy());
        read_frames(socket, line => {
          let message; try { message = JSON.parse(line); } catch { return socket.destroy(); }
          if (!authenticated) {
            if (message?.type !== "hello" || message.token !== token || settled) return socket.destroy();
            authenticated = true; settled = true; this.socket = socket; clearTimeout(handshake);
            resolve(socket);
            return;
          }
          this.receive(message);
        }, () => socket.destroy());
        socket.once("close", () => {
          clearTimeout(handshake);
          if (!authenticated || this.socket !== socket) return;
          this.socket = null;
          if (!this.closedConfirmed && this.dispatched) {
            const error = uncertain("Связь с наблюдателем индекса прервана; завершение читателя не подтверждено.");
            this.fail(error);
            this.finishClose?.(error);
          } else {
            const error = new Error("Сеанс наблюдения индекса завершён.");
            for (const pending of this.pending.values()) pending.reject(error);
            this.pending.clear();
            this.finishClose?.();
          }
        });
      });
    });
    // A listen failure can reject this promise before the listener is awaited.
    connection.catch(() => {});
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(listenAddress, resolve); });
      if (!["win32", "linux"].includes(process.platform)) fs.chmodSync(address, 0o600);
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "NODE_OPTIONS"));
      Object.assign(env, { EDT_AI_STATE_DIR: this.state, EDT_AI_OBSERVER_ADDRESS: address, EDT_AI_OBSERVER_TOKEN: token });
      const script = fileURLToPath(new URL("./index_observer_worker.mjs", import.meta.url));
      if (process.platform === "win32") worker = spawn_detached_windows(process.execPath, [script], { cwd: path.dirname(script), env, guardUntilCommit: true });
      else {
        worker = spawn(process.execPath, [script], { cwd: path.dirname(script), env, detached: true, windowsHide: true, stdio: "ignore" });
        worker.once("error", () => {});
        worker.unref();
      }
      const socket = await connection;
      if (this.closing) throw new Error("Сеанс наблюдения индекса закрывается.");
      if (process.platform === "win32") { await worker.commit(); committed = true; worker.release(); }
      socket.write(JSON.stringify({ type: "accepted" }) + "\n");
    } catch (error) {
      const socket = this.socket; this.socket = null; socket?.destroy();
      if (worker && process.platform === "win32" && !committed) {
        try { await worker.rollback(); } finally { worker.release(); }
      } else if (worker && process.platform !== "win32" && worker.exitCode === null) worker.kill("SIGTERM");
      throw error;
    } finally {
      clearTimeout(timer);
      if (server.listening) server.close();
    }
  }
  receive(message) {
    if (message?.type === "closing") { this.workerClosing = true; return; }
    if (message?.type === "closed") { this.closedConfirmed = true; this.finishClose?.(); return; }
    if (message?.type === "cleanup_failed") { const error = uncertain(message.message || "Очистка наблюдателя индекса не подтверждена."); this.fail(error); this.finishClose?.(error); return; }
    const pending = this.pending.get(message?.id);
    if (!pending || !["result", "error"].includes(message?.type)) return this.socket?.destroy();
    this.pending.delete(message.id);
    if (message.type === "result") pending.resolve(message.result);
    else {
      const error = Object.assign(new Error(message.message || "Ошибка наблюдения индекса."),
        Object.fromEntries(["code", "inputsChanged", "outcomeUnknown", "cleanupUnconfirmed", "remote"].filter(key => message[key]).map(key => [key, message[key]])));
      if (error.cleanupUnconfirmed) this.cleanupError = error;
      pending.reject(error);
    }
  }
  fail(error) {
    this.cleanupError ||= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  async observe(config, root, profile, snapshot) {
    await this.start();
    if (!this.socket || this.closing) throw uncertain("Наблюдатель индекса недоступен.");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.dispatched = true;
      this.socket.write(JSON.stringify({ type: "observe", id, config, root, profile, snapshot }) + "\n", error => {
        if (error && this.pending.delete(id)) reject(uncertain("Запрос наблюдателя индекса не доставлен."));
      });
    });
  }
  close() {
    return this.closing ||= (async () => {
      if (this.starting) await this.starting.catch(() => {});
      if (this.closedConfirmed) { this.socket?.destroy(); if (this.cleanupError) throw this.cleanupError; return; }
      if (!this.socket) { if (this.cleanupError) throw this.cleanupError; return; }
      let timer;
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            this.finishClose = error => error ? reject(error) : resolve();
            this.socket.write(JSON.stringify({ type: "close" }) + "\n", error => { if (error) reject(uncertain("Запрос завершения наблюдателя не доставлен.")); });
          }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(uncertain("Истекло время завершения наблюдателя индекса.")), 10000); }),
        ]);
      } catch (error) {
        const failure = error?.cleanupUnconfirmed ? error : uncertain("Завершение наблюдателя индекса не подтверждено.");
        this.fail(failure);
        this.socket?.destroy();
        throw failure;
      } finally { clearTimeout(timer); }
      if (this.cleanupError) throw this.cleanupError;
    })();
  }
}
