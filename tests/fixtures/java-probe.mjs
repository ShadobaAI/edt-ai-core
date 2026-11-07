import { spawn } from "node:child_process";
import fs from "node:fs";

const mode = process.env.JAVA_PROBE_TEST_MODE;
if (mode === "error") {
  process.stderr.write("Picked up JAVA_TOOL_OPTIONS: -Dauth=synthetic-private-value\n");
  process.exitCode = 1;
} else if (mode === "version") {
  process.stderr.write('Picked up JAVA_TOOL_OPTIONS: -Dauth=version "2synthetic-private-value"\nopenjdk version "21.0.2"\n');
} else if (mode === "hang") {
  process.on("SIGTERM", () => {});
  const child = spawn(process.execPath, ["-e", `process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000)`],
    { detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  child.once("message", () => fs.writeFileSync(process.env.JAVA_PROBE_TEST_PIDS, JSON.stringify([process.pid, child.pid])));
  setInterval(() => {}, 1000);
}
