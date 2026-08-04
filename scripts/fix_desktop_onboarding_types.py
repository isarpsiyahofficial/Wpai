import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
app = root / "src/frontend/App.tsx"
value = app.read_text("utf-8")
old = "onCloudflareSetup?: () => void; onReady:"
new = "onCloudflareSetup?: (() => void) | undefined; onReady:"
if value.count(old) != 1:
    raise RuntimeError(f"Expected one onboarding callback type, found {value.count(old)}")
app.write_text(value.replace(old, new, 1), "utf-8")

lock_path = root / "package-lock.json"
lock = json.loads(lock_path.read_text("utf-8"))
lock_path.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", "utf-8")
print("Desktop onboarding types fixed and lockfile formatting preserved.")
