import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
const home = process.env.CODE_INDEX_HOME;
const started = new Date().toISOString();
const paths = [
  ...fs
    .readFileSync(path.join(home, "daemon.toml"), "utf8")
    .matchAll(/^path = (.+)$/gm),
].map((match) => ({ path: JSON.parse(match[1]) }));
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/stop") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ stopping: true }));
    setTimeout(() => { server.closeAllConnections(); server.close(() => process.exit(0)); }, 50);
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pid: process.pid, status: "running", started_at: started, paths }));
});
server.listen(0, "127.0.0.1", () =>
  fs.writeFileSync(
    path.join(home, "daemon.json"),
    JSON.stringify({ pid: process.pid, http_host: "127.0.0.1", http_port: server.address().port, started_at: started }),
  ),
);
