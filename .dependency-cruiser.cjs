module.exports = {
  forbidden: [
    {
      name: "no-circular-dependencies",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "runtime-does-not-import-dev",
      severity: "error",
      from: { path: "^(scripts|mcp|hooks|policy|vanessa)/" },
      to: { path: "^(tests|tools)/" },
    },
  ],
  options: { doNotFollow: { path: "node_modules" } },
};
