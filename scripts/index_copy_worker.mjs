import { copy_and_hash_regular_file } from "./bounded_file.mjs";

// Private child of the settings process. Its only operation copies one
// already-selected runtime into the owner's pinned observation directory.
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 64 * 1024) throw new Error("Copy request is too large");
  }
  const request = JSON.parse(input);
  if (!request || Object.keys(request).sort().join(",") !== "destination,source" ||
      typeof request.source !== "string" || typeof request.destination !== "string") throw new Error("Invalid copy request");
  const digest = await copy_and_hash_regular_file(request.source, request.destination, 512 * 1024 * 1024);
  process.stdout.write(JSON.stringify({ digest }) + "\n");
} catch {
  process.stderr.write("Verified runtime copy failed\n");
  process.exitCode = 1;
}
