from pathlib import Path

path = Path(__file__).resolve().parents[1] / "src/frontend/App.tsx"
value = path.read_text("utf-8")
old = "onCloudflareSetup?: () => void; onReady:"
new = "onCloudflareSetup?: (() => void) | undefined; onReady:"
if value.count(old) != 1:
    raise RuntimeError(f"Expected one onboarding callback type, found {value.count(old)}")
path.write_text(value.replace(old, new, 1), "utf-8")
print("Desktop onboarding exact optional callback type fixed.")
