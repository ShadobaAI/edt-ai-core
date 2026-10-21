import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
const home = process.env.CODE_INDEX_HOME;
const paths = [
  ...fs
    .readFileSync(path.join(home, "daemon.toml"), "utf8")
    .matchAll(/^path = (.+)$/gm),
].map((match) => ({ path: JSON.parse(match[1]) }));
const server = createServer((req, res) =>
  res
    .writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify({ pid: process.pid, status: "running", paths })),
);
server.listen(0, "127.0.0.1", () =>
  fs.writeFileSync(
    path.join(home, "daemon.json"),
    JSON.stringify({ pid: process.pid, http_port: server.address().port }),
  ),
);
