from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def once(path: str, old: str, new: str) -> None:
    file = ROOT / path
    value = file.read_text("utf-8")
    if new in value:
        return
    if old not in value:
        raise RuntimeError(f"MISSING_ANCHOR:{path}:{old[:100]}")
    file.write_text(value.replace(old, new, 1), "utf-8")


def apply() -> None:
    once(
        "tests/worker/management-api.test.ts",
        "    vi.spyOn(env.AI,'run').mockResolvedValue({data:[[1,0,0]],usage:{input_tokens:10}} as never); vi.spyOn(env.KNOWLEDGE_INDEX,'upsert').mockResolvedValue({count:1,ids:['x']} as never);\n    const approved=await request(`/api/knowledge/${knowledgeId}`,{method:'PUT',headers:authHeaders(auth),body:JSON.stringify({title:'Teslim Süreci',category:'Süreç',content:'Kapsam onayından sonra geliştirme başlar.',status:'approved',usagePermission:'both'})}); expect(approved.status).toBe(200);\n    const row=await env.DB.prepare('SELECT status,usage_permission,vector_status,vector_version FROM business_knowledge WHERE id=?').bind(knowledgeId).first(); expect(row).toMatchObject({status:'approved',usage_permission:'both',vector_status:'indexed',vector_version:1});",
        "    const approved=await request(`/api/knowledge/${knowledgeId}`,{method:'PUT',headers:authHeaders(auth),body:JSON.stringify({title:'Teslim Süreci',category:'Süreç',content:'Kapsam onayından sonra geliştirme başlar.',status:'approved',usagePermission:'both'})}); expect(approved.status).toBe(200);\n    const row=await env.DB.prepare('SELECT status,usage_permission,vector_status,vector_version FROM business_knowledge WHERE id=?').bind(knowledgeId).first(); expect(row).toMatchObject({status:'approved',usage_permission:'both',vector_status:'pending',vector_version:0});\n    const vectorJob=await env.DB.prepare('SELECT operation,target,status FROM vector_sync_jobs WHERE knowledge_id=? ORDER BY created_at DESC LIMIT 1').bind(knowledgeId).first(); expect(vectorJob).toMatchObject({operation:'upsert',target:'cloud',status:'queued'});",
    )

    once(
        "src-tauri/Cargo.toml",
        'tauri-plugin-shell = "2.3.3"\n',
        'tauri-plugin-shell = "2.3.3"\ntauri-plugin-single-instance = "2"\ntauri-plugin-dialog = "2"\ntauri-plugin-notification = "2"\n',
    )
    once(
        "src-tauri/src/lib.rs",
        "use tauri_plugin_shell::ShellExt;\n",
        "use tauri_plugin_dialog::DialogExt;\nuse tauri_plugin_notification::NotificationExt;\nuse tauri_plugin_shell::ShellExt;\n",
    )
    once(
        "src-tauri/src/lib.rs",
        '#[derive(Debug, Serialize, Deserialize)]\n#[serde(rename_all = "camelCase")]\nstruct FaissMatch {\n    id: String,\n    score: f32,\n    metadata: Value,\n}\n',
        '#[derive(Debug, Serialize, Deserialize)]\n#[serde(rename_all = "camelCase")]\nstruct FaissMatch {\n    id: String,\n    score: f32,\n    metadata: Value,\n}\n\n#[derive(Debug, Serialize)]\n#[serde(rename_all = "camelCase")]\nstruct PickedDesktopFile {\n    name: String,\n    mime_type: String,\n    bytes: Vec<u8>,\n}\n',
    )
    once(
        "src-tauri/src/lib.rs",
        '#[tauri::command]\nfn show_main_window(app: AppHandle) -> Result<(), String> {',
        '''fn supported_file_mime(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "pdf" => Some("application/pdf"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "csv" => Some("text/csv"),
        "txt" => Some("text/plain"),
        _ => None,
    }
}

#[tauri::command]
async fn pick_desktop_file(app: AppHandle) -> Result<Option<PickedDesktopFile>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter(
            "WPAI desteklenen dosyalar",
            &["png", "jpg", "jpeg", "webp", "pdf", "docx", "xlsx", "csv", "txt"],
        )
        .blocking_pick_file();
    let Some(selected) = selected else { return Ok(None); };
    let path = selected
        .into_path()
        .map_err(|_| "Seçilen dosya yolu okunamadı.".to_string())?;
    let metadata = fs::metadata(&path)
        .map_err(|_| "Seçilen dosya bilgisi okunamadı.".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 25 * 1024 * 1024 {
        return Err("Dosya boş olamaz ve 25 MB sınırını aşamaz.".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let mime_type = supported_file_mime(extension)
        .ok_or_else(|| "Bu dosya türü desteklenmiyor.".to_string())?;
    let bytes = fs::read(&path).map_err(|_| "Seçilen dosya okunamadı.".to_string())?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("wpai-dosya")
        .chars()
        .take(180)
        .collect();
    Ok(Some(PickedDesktopFile { name, mime_type: mime_type.into(), bytes }))
}

#[tauri::command(rename_all = "camelCase")]
fn show_desktop_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let safe_title = title.trim().to_string();
    let safe_body = body.trim().to_string();
    if safe_title.is_empty()
        || safe_title.chars().count() > 100
        || safe_body.is_empty()
        || safe_body.chars().count() > 500
    {
        return Err("Bildirim başlığı veya içeriği geçersiz.".into());
    }
    app.notification()
        .builder()
        .title(safe_title)
        .body(safe_body)
        .show()
        .map_err(|_| "Windows bildirimi gösterilemedi.".to_string())
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {''',
    )
    once(
        "src-tauri/src/lib.rs",
        "    tauri::Builder::default()\n        .manage(Mutex::new(DesktopPreferences::default()))\n        .plugin(tauri_plugin_shell::init())\n",
        '''    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(Mutex::new(DesktopPreferences::default()))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
''',
    )
    once(
        "src-tauri/src/lib.rs",
        "            set_windows_autostart,\n            show_main_window,\n",
        "            set_windows_autostart,\n            pick_desktop_file,\n            show_desktop_notification,\n            show_main_window,\n",
    )
    once(
        "src-tauri/permissions/default.toml",
        '  "set_windows_autostart",\n  "show_main_window",\n',
        '  "set_windows_autostart",\n  "pick_desktop_file",\n  "show_desktop_notification",\n  "show_main_window",\n',
    )
    once(
        "src/frontend/desktop.ts",
        "  showMainWindow(): Promise<void> {\n    return requiredInvoke<void>('show_main_window');\n  },\n",
        '''  pickFile(): Promise<{ name: string; mimeType: string; bytes: number[] } | null> {
    return requiredInvoke<{ name: string; mimeType: string; bytes: number[] } | null>('pick_desktop_file');
  },
  notify(title: string, body: string): Promise<void> {
    return requiredInvoke<void>('show_desktop_notification', { title, body });
  },
  showMainWindow(): Promise<void> {
    return requiredInvoke<void>('show_main_window');
  },
''',
    )
    once(
        "src/frontend/pages/whatsapp.tsx",
        "import { Empty, formatDate } from './core';\n",
        "import { Empty, formatDate } from './core';\nimport { desktop } from '../desktop';\n",
    )
    once(
        "src/frontend/pages/whatsapp.tsx",
        "  async function changeMode(mode: string, pausedUntil: string | null = null) {",
        '''  async function chooseAttachment() {
    if (desktop.available()) {
      try {
        const selected = await desktop.pickFile();
        if (!selected) return;
        await upload(new File([new Uint8Array(selected.bytes)], selected.name, { type: selected.mimeType }));
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Native dosya seçici açılamadı.', 'error');
      }
      return;
    }
    fileRef.current?.click();
  }

  async function changeMode(mode: string, pausedUntil: string | null = null) {''',
    )
    once(
        "src/frontend/pages/whatsapp.tsx",
        '<button type="button" className="button secondary" onClick={() => fileRef.current?.click()} disabled={busy}>Dosya Ekle</button>',
        '<button type="button" className="button secondary" onClick={() => void chooseAttachment()} disabled={busy}>Dosya Ekle</button>',
    )
    once(
        "src/frontend/App.tsx",
        "import { AiPage, ContactsPage, DashboardPage, FilesPage, KnowledgePage, NotificationsPage, ReportsPage, SettingsPage, TrainingPage, WhatsAppPage } from './pages';\n",
        "import { AiPage, ContactsPage, DashboardPage, FilesPage, KnowledgePage, NotificationsPage, ReportsPage, SettingsPage, TrainingPage, WhatsAppPage } from './pages';\nimport { desktop } from './desktop';\n",
    )
    once(
        "src/frontend/App.tsx",
        "  const notify: Notify = useCallback((message, kind = 'info') => {\n    setToast({ message, kind });\n    window.setTimeout(() => setToast(null), 4500);\n  }, []);",
        "  const notify: Notify = useCallback((message, kind = 'info') => {\n    setToast({ message, kind });\n    window.setTimeout(() => setToast(null), 4500);\n    if (desktopMode && document.hidden) {\n      void desktop.notify(kind === 'error' ? 'WPAI uyarısı' : 'WPAI bildirimi', message).catch(() => undefined);\n    }\n  }, [desktopMode]);",
    )

    package = ROOT / "package.json"
    package_text = package.read_text("utf-8").replace(
        '"validate": "python scripts/validate.py"',
        '"validate": "python scripts/validate.py && python scripts/validate_spec500.py"',
    )
    package.write_text(package_text, "utf-8")

    (ROOT / "scripts/validate_spec500.py").write_text(
        '''from __future__ import annotations
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
 source="\\n".join(t(x) for x in ("src/worker/index.ts","src/worker/api.ts","src/worker/extendedApi.ts","src/worker/operationsApi.ts"))
 assert "'/campaign" not in source and '\"/campaign' not in source and "wa-campaign" not in source
 print("500-item additions validation passed.")
if __name__=="__main__": main()
''',
        "utf-8",
    )

    (ROOT / ".github/workflows/windows-desktop.yml").write_text(
        '''name: WPAI Windows Installer

on:
  push:
    branches: [main, agent/wpai-production-rebuild]
    paths:
      - 'src/**'
      - 'src-tauri/**'
      - 'sidecar/**'
      - 'rust-toolchain.toml'
      - 'package.json'
      - 'package-lock.json'
      - 'scripts/validate_spec500.py'
      - '.github/workflows/windows-desktop.yml'
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: wpai-windows-${{ github.ref }}
  cancel-in-progress: true

jobs:
  installer:
    name: Build, install and verify NSIS setup.exe
    runs-on: windows-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - uses: dtolnay/rust-toolchain@master
        with:
          toolchain: 1.97.1
          targets: x86_64-pc-windows-msvc
          components: clippy
      - name: Install locked JavaScript dependencies
        run: npm ci --no-audit --no-fund
      - name: Install FAISS sidecar dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -r sidecar/requirements.txt
      - name: Compile and test FAISS sidecar
        run: |
          python -m compileall -q sidecar
          python -m pytest -q sidecar/test_faiss_service.py
      - name: Build FAISS sidecar executable
        run: |
          pyinstaller --noconfirm --clean --onefile --name faiss-service sidecar/faiss_service.py
          New-Item -ItemType Directory -Force -Path src-tauri/bin | Out-Null
          Copy-Item dist/faiss-service.exe src-tauri/bin/faiss-service-x86_64-pc-windows-msvc.exe
      - name: Typecheck web and Worker source
        run: npm run typecheck
      - name: Rust locked unit tests
        run: cargo test --locked --manifest-path src-tauri/Cargo.toml
      - name: Rust Clippy with warnings denied
        run: cargo clippy --locked --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings
      - name: Rust locked compile check
        run: cargo check --locked --manifest-path src-tauri/Cargo.toml
      - name: Build NSIS installer
        run: npm run desktop:build
      - name: Real NSIS install, open, single-instance and uninstall smoke
        run: |
          $ErrorActionPreference='Stop'
          $installer=Get-ChildItem src-tauri/target/release/bundle/nsis -Filter *.exe -Recurse|Select-Object -First 1
          if(-not $installer){throw 'NSIS setup.exe was not produced'}
          $hash=(Get-FileHash -Algorithm SHA256 $installer.FullName).Hash.ToLowerInvariant()
          $signature=(Get-AuthenticodeSignature $installer.FullName).Status.ToString()
          $p=Start-Process $installer.FullName -ArgumentList '/S' -PassThru -Wait
          if($p.ExitCode-ne 0){throw "Install failed $($p.ExitCode)"}
          $installed=Get-ChildItem $env:LOCALAPPDATA -Filter WPAI.exe -Recurse -ErrorAction SilentlyContinue|Sort-Object LastWriteTime -Descending|Select-Object -First 1
          if(-not $installed){throw 'Installed WPAI.exe not found'}
          $first=Start-Process $installed.FullName -PassThru; Start-Sleep 10; $first.Refresh(); if($first.HasExited){throw 'WPAI exited during startup'}
          $second=Start-Process $installed.FullName -PassThru; Start-Sleep 5
          $running=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath-eq $installed.FullName})
          if($running.Count-ne 1){throw "Single-instance failed $($running.Count)"}
          $data=Join-Path $env:APPDATA 'com.wpai.desktop'; New-Item -ItemType Directory -Force $data|Out-Null
          $marker=Join-Path $data 'uninstall-preserve-marker.txt'; Set-Content $marker 'preserve-user-data'
          Stop-Process -Id $first.Id -Force -ErrorAction SilentlyContinue; Stop-Process -Id $second.Id -Force -ErrorAction SilentlyContinue
          $uninstaller=Get-ChildItem $installed.DirectoryName -Filter 'uninstall*.exe'|Select-Object -First 1
          if(-not $uninstaller){throw 'Uninstaller not found'}
          $u=Start-Process $uninstaller.FullName -ArgumentList '/S' -PassThru -Wait; Start-Sleep 3
          if($u.ExitCode-ne 0 -or (Test-Path $installed.FullName)){throw 'Uninstall failed'}
          if(-not(Test-Path $marker)){throw 'Uninstall removed user data'}
          [ordered]@{checkedAt=(Get-Date).ToUniversalTime().ToString('o');installerName=$installer.Name;installerBytes=$installer.Length;installerSha256=$hash;authenticodeStatus=$signature;installedExe=$installed.FullName;firstInstanceAlive=$true;processCountAfterSecondLaunch=$running.Count;uninstallExitCode=$u.ExitCode;userDataPreserved=$true;headSha='${{ github.sha }}'}|ConvertTo-Json|Set-Content -Encoding utf8 windows-smoke.json
      - name: Upload Windows installer and lifecycle evidence
        uses: actions/upload-artifact@v4
        with:
          name: WPAI-Windows-Setup-${{ github.sha }}
          path: |
            src-tauri/target/release/bundle/nsis/*.exe
            windows-smoke.json
          if-no-files-found: error
          retention-days: 30
''',
        "utf-8",
    )


if __name__ == "__main__":
    apply()
