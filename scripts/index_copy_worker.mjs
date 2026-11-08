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
  const keys = request && Object.keys(request).sort().join(","), identity = request?.destinationIdentity;
  const hasIdentity = Boolean(request && Object.hasOwn(request, "destinationIdentity"));
  if (!request || !["destination,source", "destination,destinationIdentity,source"].includes(keys) ||
      typeof request.source !== "string" || typeof request.destination !== "string" ||
      (process.platform === "win32") !== hasIdentity || (hasIdentity && (!identity || typeof identity !== "object" || Array.isArray(identity) ||
        Object.keys(identity).sort().join(",") !== "dev,ino" || typeof identity.dev !== "string" || typeof identity.ino !== "string" ||
        !/^\d{1,32}$/.test(identity.dev) || !/^\d{1,32}$/.test(identity.ino)))) throw new Error("Invalid copy request");
  const digest = await copy_and_hash_regular_file(request.source, request.destination, 512 * 1024 * 1024, 30000, identity || null);
  process.stdout.write(JSON.stringify({ digest }) + "\n");
} catch {
  process.stderr.write("Verified runtime copy failed\n");
  process.exitCode = 1;
}
