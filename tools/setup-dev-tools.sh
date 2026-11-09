#!/usr/bin/env bash
# Optional developer setup; no plugin build, publication, or CI changes.
set -Eeuo pipefail

finish() {
  local result=$?
  if (( result != 0 )); then
    printf '\nУстановка не завершена (код %s). Исправьте ошибку и запустите скрипт снова.\n' "$result" >&2
  fi
  if [[ -t 0 && "${CORE_DEV_SETUP_NO_PAUSE:-}" != "1" ]]; then
    read -r -p "Нажмите Enter, чтобы закрыть окно..." || true
  fi
  exit "$result"
}
trap finish EXIT

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for tool in node npm npx git codex; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Не найдена команда %s. Установите её и добавьте в PATH.\n' "$tool" >&2
    exit 1
  fi
done

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major === 24 && minor >= 11 || major >= 26)) { console.error("Нужен Node.js 24.11+ на ветке 24 или Node.js 26+; текущая версия: " + process.version); process.exit(1); }'
if ! gitRoot="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  printf 'Не найден Git-репозиторий. Откройте полную рабочую копию проекта.\n' >&2
  exit 1
fi
node -e 'const fs = require("node:fs"); let current = fs.realpathSync.native("."), gitRoot = fs.realpathSync.native(process.argv[1]); if (process.platform === "win32") { current = current.toLowerCase(); gitRoot = gitRoot.toLowerCase(); } if (current !== gitRoot) { console.error("Корень Git не совпадает с корнем проекта. Откройте полную рабочую копию."); process.exit(1); }' "$gitRoot"

printf '\n[1/6] Устанавливаем зависимости разработки из lockfile...\n'
npm ci --ignore-scripts --no-audit --no-fund
printf '\n[2/6] Подготавливаем runtime-библиотеки для локальных тестов...\n'
node tools/vendor.mjs
printf '\n[3/6] Устанавливаем Chromium для Playwright...\n'
node node_modules/@playwright/test/cli.js install chromium
printf '\n[4/6] Строим индекс GitNexus без интеграционных файлов и hooks...\n'
npx -y gitnexus@latest analyze --index-only
printf '\n[5/6] Настраиваем GitNexus MCP в Codex...\n'
node --input-type=module <<'NODE'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Use the Codex configuration API so a concurrent edit is not overwritten.
const desiredArgs = ["-y", "gitnexus@latest", "mcp"];
const isObject = value => value && typeof value === "object" && !Array.isArray(value);
const isOurs = server => server?.command === "npx" &&
  Array.isArray(server.args) && JSON.stringify(server.args) === JSON.stringify(desiredArgs);

async function configureGitNexus(request) {
  const read = () => request("config/read", { includeLayers: true });
  const before = await read();
  if (!isObject(before?.config) || !Array.isArray(before.layers))
    throw new Error("Codex не предоставил сведения о настройках и их версиях.");
  const existing = before.config.mcp_servers?.gitnexus;
  if (existing && (!isOurs(existing) || existing.enabled === false)) return "preserved";
  if (existing?.startup_timeout_sec != null) return "unchanged";
  const userLayer = before.layers.find(layer => layer.name?.type === "user" && layer.name.profile == null);
  if (typeof userLayer?.version !== "string" || !userLayer.version)
    throw new Error("Codex не предоставил версию пользовательских настроек.");
  await request("config/value/write", {
    keyPath: existing ? "mcp_servers.gitnexus.startup_timeout_sec" : "mcp_servers.gitnexus",
    value: existing ? 180 : { command: "npx", args: desiredArgs, startup_timeout_sec: 180 },
    mergeStrategy: "upsert", expectedVersion: userLayer.version,
  });
  const after = (await read())?.config?.mcp_servers?.gitnexus;
  if (!isOurs(after) || after.enabled === false || after.startup_timeout_sec !== 180)
    throw new Error("Настройка GitNexus записана, но её действующее значение не подтверждено.");
  return existing ? "updated" : "created";
}

function codexCommand() {
  if (process.platform !== "win32") return ["codex", ["app-server", "--listen", "stdio://"]];
  // npm's Windows launcher is a .cmd file and needs cmd.exe. Arguments are fixed.
  return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex app-server --listen stdio://"]];
}

async function configureWithCodex() {
  const codexDirectory = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  if (!path.isAbsolute(codexDirectory)) throw new Error("CODEX_HOME должен быть абсолютным путём.");
  fs.mkdirSync(codexDirectory, { recursive: true });
  const [command, args] = codexCommand();
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0, failed = null, closed = false;
  const fail = error => {
    if (failed) return;
    failed = error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.stderr.resume(); // Do not expose unrelated user configuration or credentials.
  child.once("error", fail);
  child.once("close", () => { closed = true; fail(new Error("Сервер настройки Codex завершился.")); });
  child.stdin.on("error", () => fail(new Error("Не удалось отправить запрос Codex.")));
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error("Codex вернул повреждённый ответ.")); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error("Codex отклонил настройку; проверьте конфигурацию и версию Codex."));
    else entry.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failed) { reject(failed); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Codex не ответил вовремя: " + method)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => {
      if (error) fail(new Error("Не удалось отправить запрос Codex."));
    });
  });
  try {
    await request("initialize", { clientInfo: { name: "1c-ai-core-dev-setup", title: "1C AI Core development setup", version: "1" }, capabilities: {} });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    return await configureGitNexus(request);
  } finally {
    lines.close();
    if (!closed) {
      child.stdin.end();
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

try {
  const result = await configureWithCodex();
  if (result === "preserved") {
    console.error("Сервер gitnexus уже настроен иначе или отключён. Существующая запись сохранена; проверьте её в Codex.");
    process.exitCode = 1;
  } else console.log(result === "unchanged" ? "Настройка GitNexus уже существует." : "Подключение GitNexus к Codex настроено.");
} catch (error) {
  console.error("Не удалось настроить GitNexus в Codex: " + error.message);
  process.exitCode = 1;
}
NODE
printf '\n[6/6] Проверяем каталог инструментов MCP сервера настроек...\n'
npm run quality:mcp

printf '\nГотово. Для нового MCP-сервера откройте новый чат или перезапустите Codex.\n'
printf 'Проверки: npm run quality:mcp, npm run quality:dependencies, npm run test:ui.\n'
