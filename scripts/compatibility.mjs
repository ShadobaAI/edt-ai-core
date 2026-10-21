import fs from "node:fs";
import { ConfigError } from "./project_paths.mjs";
export const core_version = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url), "utf8")).version;
const tuple = text => text.split(".").map(Number);
const compare = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]); return 0; };
export function satisfies_core(range, version = core_version) {
  if (typeof range !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new ConfigError("Invalid core compatibility range/version");
  const clauses = range.split("||").map(part => part.trim().split(/\s+/));
  const parsed = clauses.map(clause => clause.map(token => {
    const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)$/.exec(token);
    if (!match) throw new ConfigError("Invalid core compatibility comparator: " + token);
    return [match[1] || "=", tuple(match[2])];
  }));
  const actual = tuple(version);
  return parsed.some(clause => clause.every(([op, expected]) => {
    const c = compare(actual, expected);
    if (op === "^") {
      const upper = expected[0] ? [expected[0]+1,0,0] : expected[1] ? [0,expected[1]+1,0] : [0,0,expected[2]+1];
      return c >= 0 && compare(actual, upper) < 0;
    }
    if (op === "~") return c >= 0 && compare(actual, [expected[0], expected[1]+1, 0]) < 0;
    return { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[op];
  }));
}
