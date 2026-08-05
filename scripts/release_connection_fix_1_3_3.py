from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OLD = "1.3.2"
NEW = "1.3.3"


def read(path: str) -> str:
    return (ROOT / path).read_text("utf-8")


def write(path: str, value: str) -> None:
    (ROOT / path).write_text(value, "utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    value = read(path)
    if value.count(old) != 1:
        raise SystemExit(f"Expected exactly one version marker in {path}: {old!r}, found {value.count(old)}")
    write(path, value.replace(old, new, 1))


package_path = ROOT / "package.json"
package = json.loads(package_path.read_text("utf-8"))
if package.get("version") != OLD:
    raise SystemExit(f"Unexpected package version: {package.get('version')}")
package["version"] = NEW
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", "utf-8")

lock_path = ROOT / "package-lock.json"
lock = json.loads(lock_path.read_text("utf-8"))
if lock.get("version") != OLD or lock.get("packages", {}).get("", {}).get("version") != OLD:
    raise SystemExit("package-lock root version is not 1.3.2")
lock["version"] = NEW
lock["packages"][""]["version"] = NEW
lock["packages"][""]["scripts"] = package["scripts"]
lock_path.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", "utf-8")

config_path = ROOT / "src-tauri/tauri.conf.json"
config = json.loads(config_path.read_text("utf-8"))
if config.get("version") != OLD:
    raise SystemExit(f"Unexpected Tauri version: {config.get('version')}")
config["version"] = NEW
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", "utf-8")

cargo_toml = read("src-tauri/Cargo.toml")
pattern = r'(?m)^(name = "wpai-desktop"\nversion = ")1\.3\.2("$)'
cargo_toml, count = re.subn(pattern, rf"\g<1>{NEW}\g<2>", cargo_toml, count=1)
if count != 1:
    raise SystemExit("Cargo.toml root package version marker not found")
write("src-tauri/Cargo.toml", cargo_toml)

cargo_lock = read("src-tauri/Cargo.lock")
pattern = r'(?m)^(name = "wpai-desktop"\nversion = ")1\.3\.2("$)'
cargo_lock, count = re.subn(pattern, rf"\g<1>{NEW}\g<2>", cargo_lock, count=1)
if count != 1:
    raise SystemExit("Cargo.lock root package version marker not found")
write("src-tauri/Cargo.lock", cargo_lock)

replace_once("src/frontend/api.ts", "appVersion: '1.3.2'", "appVersion: '1.3.3'")
replace_once("desktop-bootstrap/bootstrap.mjs", "appVersion: '1.3.2'", "appVersion: '1.3.3'")
replace_once("scripts/validate_spec500.py", 'version != "1.3.2"', 'version != "1.3.3"')
replace_once("scripts/validate_spec500.py", 'Expected final audited version 1.3.2', 'Expected final audited version 1.3.3')

checks = {
    "package.json": '"version": "1.3.3"',
    "package-lock.json": '"version": "1.3.3"',
    "src-tauri/tauri.conf.json": '"version": "1.3.3"',
    "src-tauri/Cargo.toml": 'name = "wpai-desktop"\nversion = "1.3.3"',
    "src-tauri/Cargo.lock": 'name = "wpai-desktop"\nversion = "1.3.3"',
    "src/frontend/api.ts": "appVersion: '1.3.3'",
    "desktop-bootstrap/bootstrap.mjs": "appVersion: '1.3.3'",
    "scripts/validate_spec500.py": 'Expected final audited version 1.3.3',
}
for path, marker in checks.items():
    if marker not in read(path):
        raise SystemExit(f"Release marker missing after update: {path} -> {marker}")

print("WPAI connection repair release version synchronized to 1.3.3.")
