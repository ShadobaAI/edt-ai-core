import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
fs.mkdirSync("vendor", { recursive: true });
await build({
  absWorkingDir: process.cwd(),
  entryPoints: [path.resolve("tools/vendor-entry.mjs")],
  outfile: "vendor/deps.mjs",
  tsconfigRaw: {},
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
const licenses = [
  "yaml",
  "ajv",
  "fflate",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
  "koffi",
];
fs.writeFileSync(
  "vendor/NOTICE.txt",
  licenses
    .map((name) => {
      const dir = "node_modules/" + name;
      const file = fs
        .readdirSync(dir)
        .find((file) => /^licen[sc]e(?:\.|$)/i.test(file));
      if (!file) throw new Error("Missing dependency license: " + name);
      return name + "\n\n" + fs.readFileSync(dir + "/" + file, "utf8");
    })
    .join("\n\n----------------\n\n"),
);
// Include both Windows addons even when packaging on Linux/macOS. Each npm
// tarball is verified against the SHA-512 integrity pinned in package-lock.json.
const { extract_binary } = await import("../scripts/archives.mjs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
for (const arch of ["x64", "arm64"]) {
  const entry = lock.packages["node_modules/@koromix/koffi-win32-" + arch];
  if (
    !entry ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity) ||
    !entry.resolved.startsWith("https://registry.npmjs.org/")
  )
    throw new Error("Missing locked Koffi artifact");
  const cache = path.join(
    ".work/native-cache",
    createHash("sha256").update(entry.integrity).digest("hex") + ".tgz",
  );
  let data;
  if (fs.existsSync(cache)) data = fs.readFileSync(cache);
  else {
    const response = await fetch(entry.resolved, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error("Koffi download failed");
    data = Buffer.from(await response.arrayBuffer());
  }
  if (
    "sha512-" + createHash("sha512").update(data).digest("base64") !==
    entry.integrity
  )
    throw new Error("Koffi integrity mismatch");
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, data);
  const dir = path.join("vendor/native", "win32_" + arch);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "koffi.node"),
    extract_binary(data, "tar.gz", "koffi.node"),
  );
}
