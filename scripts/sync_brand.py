from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRAND_PATH = ROOT / "brand/product-brand.json"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text("utf-8"))


def save_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", "utf-8")


def expected_outputs() -> dict[str, str]:
    brand = load_json(BRAND_PATH)
    return {str(key): str(value) for key, value in brand.items()}


def apply() -> None:
    brand = expected_outputs()
    tauri_path = ROOT / "src-tauri/tauri.conf.json"
    tauri = load_json(tauri_path)
    tauri["productName"] = brand["productName"]
    tauri["identifier"] = brand["identifier"]
    tauri["app"]["windows"][0]["title"] = brand["windowTitle"]
    tauri["bundle"]["publisher"] = brand["publisher"]
    tauri["bundle"]["shortDescription"] = brand["shortDescription"]
    tauri["bundle"]["icon"] = [brand["iconIco"].removeprefix("src-tauri/")]
    save_json(tauri_path, tauri)

    index_path = ROOT / "index.html"
    html = index_path.read_text("utf-8")
    html = re.sub(r'<meta name="description" content="[^"]*"\s*/>', f'<meta name="description" content="{brand["htmlDescription"]}" />', html)
    html = re.sub(r"<title>.*?</title>", f'<title>{brand["appName"]}</title>', html)
    index_path.write_text(html, "utf-8")


def check() -> None:
    brand = expected_outputs()
    tauri = load_json(ROOT / "src-tauri/tauri.conf.json")
    checks = {
        "tauri productName": tauri.get("productName") == brand["productName"],
        "tauri identifier": tauri.get("identifier") == brand["identifier"],
        "window title": tauri["app"]["windows"][0].get("title") == brand["windowTitle"],
        "publisher": tauri["bundle"].get("publisher") == brand["publisher"],
        "installer icon": brand["iconIco"].removeprefix("src-tauri/") in tauri["bundle"].get("icon", []),
        "icon file": (ROOT / brand["iconIco"]).is_file(),
    }
    html = (ROOT / "index.html").read_text("utf-8")
    checks["html title"] = f'<title>{brand["appName"]}</title>' in html
    migration = (ROOT / "migrations/0001_initial.sql").read_text("utf-8")
    checks["D1 default app name"] = f"DEFAULT '{brand['appName']}'" in migration
    app = (ROOT / "src/frontend/App.tsx").read_text("utf-8")
    checks["React default app name"] = f"app_name: '{brand['appName']}'" in app
    failures = [name for name, passed in checks.items() if not passed]
    if failures:
        raise SystemExit("Central brand synchronization failed: " + ", ".join(failures))
    print("Central product brand synchronization passed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.apply:
        apply()
    check()
