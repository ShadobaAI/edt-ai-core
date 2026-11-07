import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { match_testclient_binding, windows_tcp_rows } from "../scripts/windows_process.mjs";

for (const family of [2, 23]) test(`TCP binding requires reciprocal established connections (family ${family})`, () => {
  const address = family === 2 ? "7f000001" : "00000000000000000000000000000001";
  const listener = { family, state: 2, pid: 100, localPort: 2000 };
  const manager = { family, state: 5, pid: 100, localAddress: address, localScope: 0, localPort: 3100,
    remoteAddress: address, remoteScope: 0, remotePort: 4000 };
  const client = { family, state: 5, pid: 200, localAddress: address, localScope: 0, localPort: 4000,
    remoteAddress: address, remoteScope: 0, remotePort: 3100 };
  const caller = { ...manager, pid: 300, localPort: 3200, remotePort: 2000 };
  const mcp = { ...client, pid: 100, localPort: 2000, remotePort: 3200 };
  const base = [listener, manager, client, caller, mcp];
  const match = rows => match_testclient_binding(rows, 2000, 200, 4000, 300);
  assert.equal(match(base), 100);
  assert.equal(match([listener, manager, caller, mcp]), null);
  assert.equal(match([listener, manager, { ...client, pid: 201 }, caller, mcp]), null);
  assert.equal(match([listener, manager, { ...client, state: 2 }, caller, mcp]), null);
  assert.equal(match([listener, manager, { ...client, remoteAddress: "00" }, caller, mcp]), null);
  assert.equal(match([listener, manager, { ...client, remoteScope: 1 }, caller, mcp]), null);
  assert.equal(match([listener, manager, { ...client, family: family === 2 ? 23 : 2 }, caller, mcp]), null);
  assert.equal(match([...base, { ...listener, pid: 101 }]), null);
  assert.equal(match([...base, { ...manager, localPort: 3101 }]), null);
  assert.equal(match(base.filter(row => row !== caller)), null);
  assert.equal(match(base.map(row => row === mcp ? { ...mcp, pid: 101 } : row)), null);
  assert.equal(match([...base, { ...caller, localPort: 3201 }]), null, "an old MCP connection prevents accepting a replaced server");
  assert.equal(match_testclient_binding(base, 2000, 200, 4001, 300), null);
});

for (const [family, address] of [[2, "127.0.0.1"], [23, "::1"]]) {
  test(`Windows TCP table identifies an actual loopback connection (family ${family})`, { skip: process.platform !== "win32" }, async t => {
    const child = spawn(process.execPath, ["-e", `
      const net = require('node:net');
      const server = net.createServer(socket => socket.on('error', () => {}));
      server.on('error', error => process.send({ error: error.code }));
      server.listen(0, process.argv[1], () => process.send({ port: server.address().port }));
      process.on('disconnect', () => server.close());
    `, address], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { child.kill(); });
    const [info] = await once(child, "message");
    if (info.error && family === 23 && ["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(info.error)) return t.skip("IPv6 loopback is unavailable");
    assert.ok(info.port, info.error);
    const mcp = net.createServer();
    mcp.listen(0, address);
    await once(mcp, "listening");
    const socket = net.connect(info.port, address);
    await once(socket, "connect");
    const mcpSocket = net.connect(mcp.address().port, address);
    await once(mcpSocket, "connect");
    t.after(() => { socket.destroy(); mcpSocket.destroy(); mcp.close(); });
    const rows = windows_tcp_rows(family);
    assert.equal(match_testclient_binding(rows, mcp.address().port, child.pid, info.port), process.pid);
    assert.equal(match_testclient_binding(rows, mcp.address().port, child.pid + 1, info.port), null);
  });
}
