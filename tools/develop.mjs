// Optional npm script entrypoint; the same operations are callable with Node.
await import("./vendor.mjs");
if (process.argv[2] === "test") await import("./test.mjs");
else if (process.argv[2] === "build") {
  const { package_plugin } = await import("./package-plugin.mjs");
  console.log(JSON.stringify(package_plugin()));
} else throw new Error("Expected test or build");
