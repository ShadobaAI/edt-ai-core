"""Create only a synthetic BSL project in the supplied directory."""
import argparse
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from common import ROOT, dump, load
p = argparse.ArgumentParser()
p.add_argument("directory", type=Path)
a = p.parse_args()
root = a.directory.resolve()
(root / "src").mkdir(parents=True, exist_ok=True)
data = load(ROOT / "profiles/generic-1c/profile.yaml")
data["project"] = {"id": "smoke", "purpose": "Isolated runtime smoke fixture"}
data["repositories"] = [{"id": "fixture", "path": ".", "alias": "fixture"}]
data["roots"] = {"source": ["src"], "protected": ["src"]}
dump(data, root / ".ai/project.yaml")
(root / "src/Module.bsl").write_text(
    'Функция Сложить(Первое, Второе) Экспорт\n'
    '    Возврат Первое + Второе;\nКонецФункции\n', encoding="utf-8")
(root / "src/Broken.bsl").write_text('Процедура Ошибка(\n', encoding="utf-8")
print(root)

