from __future__ import annotations
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def t(p): return (ROOT/p).read_text("utf-8")
def req(p,*n):
 v=t(p)
 for x in n:
  if x not in v: raise AssertionError(f"500-item gate missing in {p}: {x}")
def main():
 p=json.loads(t("package.json")); l=json.loads(t("package-lock.json"))
 assert p.get("overrides",{}).get("undici")=="7.29.0"
 assert l.get("packages",{}).get("node_modules/undici",{}).get("version")=="7.29.0"
 req("src-tauri/Cargo.toml","tauri-plugin-single-instance","tauri-plugin-dialog","tauri-plugin-notification")
 req("src-tauri/src/lib.rs","tauri_plugin_single_instance::init","pick_desktop_file","show_desktop_notification","faiss_replace")
 req("src/frontend/pages/whatsapp.tsx","desktop.pickFile()")
 req("src/frontend/App.tsx","desktop.notify(")
 req("tests/worker/training-vector.test.ts","wrong-customer vectors","prompt injection","duplicate: true")
 req("tests/worker/meta-paused-queue.test.ts","does not call Meta")
 req("tests/e2e/responsive.spec.mjs","['training', 'AI Eğitim Merkezi']")
 req("migrations/0010_vector_artifacts.sql","knowledge_vector_artifacts")
 req("src/worker/localIndexApi.ts","/training/local-index-bundle")
 req(".github/workflows/windows-desktop.yml","Real NSIS install, open, single-instance and uninstall smoke","windows-smoke.json")
 tauri=json.loads(t("src-tauri/tauri.conf.json")); assert tauri["build"]["frontendDist"]=="../dist/web"
 for w in tauri["app"]["windows"]: assert "workers.dev" not in str(w.get("url",""))
 source="\n".join(t(x) for x in ("src/worker/index.ts","src/worker/api.ts","src/worker/extendedApi.ts","src/worker/operationsApi.ts"))
 assert "'/campaign" not in source and '"/campaign' not in source and "wa-campaign" not in source
 print("500-item additions validation passed.")
if __name__=="__main__": main()
