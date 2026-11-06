import { once } from "node:events";
import { launch, stop_child } from "../scripts/processes.mjs";

export async function run_tests(files, { timeout = 8 * 60 * 1000, stdio = "inherit" } = {}) {
  // A test-file timeout alone can still wait on a blocked native call or an
  // inherited pipe. Keep the outer deadline on a responsive, separate process.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "NODE_TEST_CONTEXT"));
  const child = launch(process.execPath, ["--test", "--test-timeout=300000", ...files], { stdio, env });
  let expired = false, stopping;
  const timer = setTimeout(() => {
    expired = true;
    process.stderr.write(`Regression suite timed out after ${timeout} ms; stopping owned test processes.\n`);
    stopping = stop_child(child, 0);
    stopping.catch(() => {});
  }, timeout);
  try {
    const [code] = await once(child, "close");
    await stopping;
    return expired ? 1 : code ?? 1;
  } finally {
    clearTimeout(timer);
    await stop_child(child, 0);
  }
}
