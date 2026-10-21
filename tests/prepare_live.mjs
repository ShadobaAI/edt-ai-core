// Creates only synthetic BSL sources at an explicitly supplied destination.
import fs from "node:fs";
import path from "node:path";
import { ROOT, load, dump, argumentsOf } from "../scripts/common.mjs";
import { resolve } from "../scripts/project_paths.mjs";
const root = resolve(argumentsOf()._[0]);
fs.mkdirSync(path.join(root, "src"), { recursive: true });
const data = load(path.join(ROOT, "profiles/generic-1c/profile.yaml"));
data.project = { id: "smoke", purpose: "Isolated runtime smoke fixture" };
data.repositories = [{ id: "fixture", path: ".", alias: "fixture" }];
data.roots = { source: ["src"], protected: ["src"] };
dump(data, path.join(root, ".ai/project.yaml"));
fs.writeFileSync(
  path.join(root, "src/Module.bsl"),
  "Функция Сложить(Первое, Второе) Экспорт\n    Возврат Первое + Второе;\nКонецФункции\n",
);
fs.writeFileSync(path.join(root, "src/Broken.bsl"), "Процедура Ошибка(\n");
console.log(root);
