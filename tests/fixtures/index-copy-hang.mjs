import fs from "node:fs";
import { spawn } from "node:child_process";

process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000)"],
  { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
child.once("message", () => fs.writeFileSync(process.env.EDT_AI_TEST_HANG_MARKER, JSON.stringify({ worker: process.pid, child: child.pid })));
process.stdin.resume();
setInterval(() => {}, 1000);
