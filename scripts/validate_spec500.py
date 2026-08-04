from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def text(path: str) -> str:
    return (ROOT / path).read_text("utf-8")


def require(path: str, *needles: str) -> None:
    value = text(path)
    for needle in needles:
        if needle not in value:
            raise AssertionError(f"500-item gate missing in {path}: {needle}")


def main() -> None:
    package = json.loads(text("package.json"))
    lock = json.loads(text("package-lock.json"))
    if package.get("overrides", {}).get("undici") != "7.29.0":
        raise AssertionError("Patched Undici override is not pinned")
    if lock.get("packages", {}).get("node_modules/undici", {}).get("version") != "7.29.0":
        raise AssertionError("package-lock.json does not contain patched Undici 7.29.0")

    require("src-tauri/Cargo.toml", "tauri-plugin-single-instance", "tauri-plugin-dialog", "tauri-plugin-notification")
    require("src-tauri/src/lib.rs", "tauri_plugin_single_instance::init", "pick_desktop_file", "show_desktop_notification", "faiss_replace", "mod cloudflare")
    require("src-tauri/src/cloudflare.rs", "cloudflare_setup", "cloudflare_scan", "cloudflare_repair", "Windows Credential Manager")
    require("desktop-bootstrap/bootstrap.mjs", "D1_BLOCKED", "installAndDeploy", "createOrVerifyAdmin")
    require("src/frontend/App.tsx", "CloudflareSetupForm", "Cloudflare’ı Bağla, Eksikleri Kur ve Giriş Yap")
    require("src/frontend/pages/settings.tsx", "desktop.cloudflareScan", "desktop.cloudflareRepair", "desktop.cloudflareForget")
    require("src/frontend/pages/whatsapp.tsx", "desktop.pickFile()")
    require("src/frontend/App.tsx", "desktop.notify(")
    require("tests/worker/training-vector.test.ts", "wrong-customer vectors", "prompt injection", "duplicate: true")
    require("tests/worker/meta-paused-queue.test.ts", "does not call Meta")
    require("tests/e2e/responsive.spec.mjs", "['training', 'AI Eğitim Merkezi']")
    require("migrations/0010_local_vector_artifacts.sql", "knowledge_vector_artifacts")
    require("src/worker/localIndexApi.ts", "/training/local-index-bundle")
    require(
        ".github/workflows/windows-desktop.yml",
        "Real NSIS install, open, single-instance and uninstall smoke",
        "windows-smoke.json",
        "Prepare packaged Cloudflare bootstrap runtime",
        "cloudflareBootstrapScript",
    )

    tauri = json.loads(text("src-tauri/tauri.conf.json"))
    if tauri["build"]["frontendDist"] != "../dist/web":
        raise AssertionError("Windows app must package the React build")
    if tauri.get("bundle", {}).get("resources", {}).get("../desktop-bootstrap/") != "cloudflare-bootstrap/":
        raise AssertionError("Windows app must package the local Cloudflare bootstrap runtime")
    for window in tauri["app"]["windows"]:
        if "workers.dev" in str(window.get("url", "")):
            raise AssertionError("Windows shell must not load a remote site")

    worker_source = "\n".join(
        text(path)
        for path in (
            "src/worker/index.ts",
            "src/worker/api.ts",
            "src/worker/extendedApi.ts",
            "src/worker/operationsApi.ts",
        )
    )
    if "'/campaign" in worker_source or '"/campaign' in worker_source or "wa-campaign" in worker_source:
        raise AssertionError("Campaign execution capability returned to active Worker source")

    print(
        "500-item additions validation passed: packaged Tauri, native desktop capabilities, "
        "rotating desktop auth, cloud/local vector identity and mandatory safety tests are present."
    )


if __name__ == "__main__":
    main()
