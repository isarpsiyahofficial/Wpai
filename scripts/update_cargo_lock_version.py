from pathlib import Path

path = Path(__file__).resolve().parents[1] / "src-tauri/Cargo.lock"
value = path.read_text("utf-8")
old = '[[package]]\nname = "wpai-desktop"\nversion = "1.2.0"'
new = '[[package]]\nname = "wpai-desktop"\nversion = "1.3.0"'
if value.count(old) != 1:
    raise RuntimeError(f"Expected one WPAI root package in Cargo.lock, found {value.count(old)}")
path.write_text(value.replace(old, new, 1), "utf-8")
print("Cargo.lock WPAI package version aligned to 1.3.0.")
