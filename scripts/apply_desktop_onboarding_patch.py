from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text("utf-8")


def write(path: str, value: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value, "utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    value = read(path)
    count = value.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:100]!r}")
    write(path, value.replace(old, new, 1))


CLOUDFLARE_RS = r'''use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

const ACCOUNT_ID: &str = "ad8e99c82c6c17d823f6877ff1efade4";
const KEYRING_SERVICE: &str = "WPAI Cloudflare Connection";
const KEYRING_USER: &str = "ad8e99c82c6c17d823f6877ff1efade4";
const MAX_ENGINE_OUTPUT: usize = 2_000_000;

fn validate_account_id(value: &str) -> Result<(), String> {
    if value != ACCOUNT_ID {
        return Err("Cloudflare Account ID proje hesabıyla eşleşmiyor.".into());
    }
    Ok(())
}

fn validate_api_token(value: &str) -> Result<(), String> {
    if !(30..=4096).contains(&value.len()) || value.chars().any(char::is_whitespace) {
        return Err("Cloudflare API tokeni geçersiz.".into());
    }
    Ok(())
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "Windows Credential Manager açılamadı.".to_string())
}

fn load_api_token() -> Result<Option<String>, String> {
    match credential_entry()?.get_password() {
        Ok(value) => {
            validate_api_token(&value)?;
            Ok(Some(value))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Kayıtlı Cloudflare bağlantısı okunamadı.".into()),
    }
}

fn save_api_token(value: &str) -> Result<(), String> {
    validate_api_token(value)?;
    credential_entry()?
        .set_password(value)
        .map_err(|_| "Cloudflare bağlantısı Windows Credential Manager'a kaydedilemedi.".to_string())
}

fn remove_api_token() -> Result<(), String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Cloudflare bağlantısı Windows Credential Manager'dan kaldırılamadı.".into()),
    }
}

fn resolve_token(api_token: Option<String>) -> Result<(String, bool), String> {
    if let Some(value) = api_token {
        let trimmed = value.trim().to_string();
        validate_api_token(&trimmed)?;
        return Ok((trimmed, true));
    }
    let stored = load_api_token()?.ok_or_else(|| "Cloudflare API tokeni girin.".to_string())?;
    Ok((stored, false))
}

fn bootstrap_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| "WPAI paket kaynakları bulunamadı.".to_string())?
        .join("cloudflare-bootstrap");
    if !root.join("bootstrap.mjs").is_file() || !root.join("runtime").join("node.exe").is_file() {
        return Err("Cloudflare kurulum motoru Windows paketinde eksik.".into());
    }
    Ok(root)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|_| "Kurulum çalışma klasörü oluşturulamadı.".to_string())?;
    for entry in fs::read_dir(source).map_err(|_| "Paketlenmiş proje kaynakları okunamadı.".to_string())? {
        let entry = entry.map_err(|_| "Paketlenmiş proje kaydı okunamadı.".to_string())?;
        let file_type = entry.file_type().map_err(|_| "Paketlenmiş proje türü okunamadı.".to_string())?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).map_err(|_| "Paketlenmiş proje dosyası kopyalanamadı.".to_string())?;
        }
    }
    Ok(())
}

fn prepare_project(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    let source = root.join("project");
    if !source.join("package-lock.json").is_file() || !source.join("wrangler.jsonc").is_file() {
        return Err("Cloudflare dağıtım kaynakları Windows paketinde eksik.".into());
    }
    let work_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "WPAI veri klasörü bulunamadı.".to_string())?
        .join("cloudflare-bootstrap");
    let destination = work_root.join("project");
    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|_| "Eski Cloudflare kurulum çalışma alanı temizlenemedi.".to_string())?;
    }
    copy_tree(&source, &destination)?;
    Ok(destination)
}

fn sanitize(mut value: String, secrets: &[&str]) -> String {
    for secret in secrets {
        if secret.len() >= 8 {
            value = value.replace(secret, "[REDACTED]");
        }
    }
    value.replace(['\r', '\n'], " ").chars().take(1800).collect()
}

fn run_engine(
    app: &AppHandle,
    mut payload: Value,
    token: &str,
    password: Option<&str>,
    needs_project: bool,
) -> Result<Value, String> {
    let root = bootstrap_root(app)?;
    let project = if needs_project {
        prepare_project(app, &root)?
    } else {
        app.path()
            .app_data_dir()
            .map_err(|_| "WPAI veri klasörü bulunamadı.".to_string())?
            .join("cloudflare-bootstrap")
            .join("project")
    };
    payload["apiToken"] = Value::String(token.to_string());
    let input = serde_json::to_vec(&payload).map_err(|_| "Cloudflare kurulum isteği hazırlanamadı.".to_string())?;

    let mut command = Command::new(root.join("runtime").join("node.exe"));
    command
        .arg(root.join("bootstrap.mjs"))
        .env("WPAI_BOOTSTRAP_ROOT", &root)
        .env("WPAI_PROJECT_DIR", &project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "Cloudflare kurulum motoru başlatılamadı.".to_string())?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Cloudflare kurulum girişi açılamadı.".to_string())?
        .write_all(&input)
        .map_err(|_| "Cloudflare kurulum bilgileri motora iletilemedi.".to_string())?;
    let output = child.wait_with_output().map_err(|_| "Cloudflare kurulum motoru tamamlanamadı.".to_string())?;
    if output.stdout.len() > MAX_ENGINE_OUTPUT || output.stderr.len() > MAX_ENGINE_OUTPUT {
        return Err("Cloudflare kurulum motoru beklenmeyen büyüklükte çıktı üretti.".into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parsed = serde_json::from_str::<Value>(&stdout).map_err(|_| {
        let detail = sanitize(String::from_utf8_lossy(&output.stderr).to_string(), &[token, password.unwrap_or("")]);
        format!("Cloudflare kurulum cevabı okunamadı. {detail}")
    })?;
    if !output.status.success() || parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Cloudflare kurulumu tamamlanamadı.");
        return Err(sanitize(message.to_string(), &[token, password.unwrap_or("")]));
    }
    Ok(parsed)
}

#[tauri::command]
pub fn cloudflare_connection_status() -> Result<Value, String> {
    Ok(json!({
        "configured": load_api_token()?.is_some(),
        "accountId": ACCOUNT_ID,
        "storage": "Windows Credential Manager"
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub fn cloudflare_scan(app: AppHandle, account_id: String, api_token: Option<String>) -> Result<Value, String> {
    validate_account_id(&account_id)?;
    let (token, supplied) = resolve_token(api_token)?;
    let result = run_engine(&app, json!({ "action": "scan", "accountId": account_id }), &token, None, false)?;
    if supplied {
        save_api_token(&token)?;
    }
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cloudflare_repair(
    app: AppHandle,
    account_id: String,
    api_token: Option<String>,
    actions: Vec<String>,
) -> Result<Value, String> {
    validate_account_id(&account_id)?;
    if actions.len() > 20 {
        return Err("Cloudflare onarım listesi çok büyük.".into());
    }
    let (token, supplied) = resolve_token(api_token)?;
    let result = run_engine(
        &app,
        json!({ "action": "repair", "accountId": account_id, "actions": actions }),
        &token,
        None,
        false,
    )?;
    if supplied {
        save_api_token(&token)?;
    }
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub fn cloudflare_setup(
    app: AppHandle,
    account_id: String,
    api_token: String,
    admin_name: String,
    admin_email: String,
    admin_password: String,
) -> Result<Value, String> {
    validate_account_id(&account_id)?;
    validate_api_token(api_token.trim())?;
    let token = api_token.trim().to_string();
    let result = run_engine(
        &app,
        json!({
            "action": "setup",
            "accountId": account_id,
            "adminName": admin_name,
            "adminEmail": admin_email,
            "adminPassword": admin_password
        }),
        &token,
        Some(&admin_password),
        true,
    )?;
    save_api_token(&token)?;
    Ok(result)
}

#[tauri::command]
pub fn cloudflare_forget() -> Result<Value, String> {
    remove_api_token()?;
    Ok(json!({ "forgotten": true, "accountId": ACCOUNT_ID }))
}

#[cfg(test)]
mod tests {
    use super::{validate_account_id, validate_api_token, ACCOUNT_ID};

    #[test]
    fn accepts_only_the_bound_cloudflare_account() {
        assert!(validate_account_id(ACCOUNT_ID).is_ok());
        assert!(validate_account_id("00000000000000000000000000000000").is_err());
    }

    #[test]
    fn rejects_short_or_whitespace_cloudflare_tokens() {
        assert!(validate_api_token(&"a".repeat(40)).is_ok());
        assert!(validate_api_token("short").is_err());
        assert!(validate_api_token(&format!("{} ", "a".repeat(40))).is_err());
    }
}
'''


def main() -> None:
    write("src-tauri/src/cloudflare.rs", CLOUDFLARE_RS)

    replace_once("src-tauri/src/lib.rs", "use serde::{Deserialize, Serialize};", "mod cloudflare;\n\nuse serde::{Deserialize, Serialize};")
    replace_once(
        "src-tauri/src/lib.rs",
        "            quit_application,\n            faiss_health,",
        "            quit_application,\n            cloudflare::cloudflare_connection_status,\n            cloudflare::cloudflare_scan,\n            cloudflare::cloudflare_repair,\n            cloudflare::cloudflare_setup,\n            cloudflare::cloudflare_forget,\n            faiss_health,",
    )
    replace_once(
        "src-tauri/src/lib.rs",
        '''    fn desktop_permissions_contain_no_provider_secrets() {
        let permissions = include_str!("../permissions/default.toml").to_ascii_lowercase();
        assert!(!permissions.contains("cloudflare_token"));
        assert!(!permissions.contains("meta_access"));
        assert!(permissions.contains("save_desktop_refresh_token"));
        let capability = include_str!("../capabilities/local.json").to_ascii_lowercase();
        assert!(!capability.contains("workers.dev"));
        assert!(!capability.contains("remote"));
    }''',
        '''    fn desktop_permissions_expose_operations_but_never_raw_provider_secrets() {
        let permissions = include_str!("../permissions/default.toml").to_ascii_lowercase();
        assert!(permissions.contains("cloudflare_setup"));
        assert!(permissions.contains("cloudflare_scan"));
        assert!(permissions.contains("cloudflare_repair"));
        assert!(permissions.contains("cloudflare_forget"));
        assert!(!permissions.contains("load_cloudflare_api_token"));
        assert!(!permissions.contains("meta_access_token"));
        assert!(permissions.contains("save_desktop_refresh_token"));
        let capability = include_str!("../capabilities/local.json").to_ascii_lowercase();
        assert!(!capability.contains("workers.dev"));
        assert!(!capability.contains("remote"));
    }''',
    )

    permissions = read("src-tauri/permissions/default.toml")
    replace_once(
        "src-tauri/permissions/default.toml",
        '  "quit_application",\n  "faiss_health",',
        '  "quit_application",\n  "cloudflare_connection_status",\n  "cloudflare_scan",\n  "cloudflare_repair",\n  "cloudflare_setup",\n  "cloudflare_forget",\n  "faiss_health",',
    )
    replace_once(
        "src-tauri/permissions/default.toml",
        "Allows the packaged WPAI window to manage only its opaque desktop session, local preferences and local FAISS cache.",
        "Allows the packaged WPAI window to manage its opaque session, local preferences, local Cloudflare onboarding and local FAISS cache without exposing stored provider secrets.",
    )

    replace_once(
        "src/frontend/desktop.ts",
        '''  quit(): Promise<void> {
    return requiredInvoke<void>('quit_application');
  },
  faissHealth(): Promise<Record<string, unknown>> {''',
        '''  quit(): Promise<void> {
    return requiredInvoke<void>('quit_application');
  },
  cloudflareConnectionStatus(): Promise<{ configured: boolean; accountId: string; storage: string }> {
    return requiredInvoke('cloudflare_connection_status');
  },
  cloudflareScan(accountId: string, apiToken?: string): Promise<Record<string, unknown>> {
    return requiredInvoke('cloudflare_scan', { accountId, apiToken: apiToken || null });
  },
  cloudflareRepair(accountId: string, actions: string[], apiToken?: string): Promise<Record<string, unknown>> {
    return requiredInvoke('cloudflare_repair', { accountId, actions, apiToken: apiToken || null });
  },
  cloudflareSetup(input: { accountId: string; apiToken: string; adminName: string; adminEmail: string; adminPassword: string }): Promise<Record<string, unknown>> {
    return requiredInvoke('cloudflare_setup', input);
  },
  cloudflareForget(): Promise<{ forgotten: boolean; accountId: string }> {
    return requiredInvoke('cloudflare_forget');
  },
  faissHealth(): Promise<Record<string, unknown>> {''',
    )

    replace_once(
        "src/frontend/App.tsx",
        "type AuthState = { phase: 'loading' | 'setup' | 'desktopSetup' | 'login' | 'ready'; admin?: Admin };",
        "type AuthState = { phase: 'loading' | 'setup' | 'cloudflareSetup' | 'login' | 'ready'; admin?: Admin };",
    )
    replace_once(
        "src/frontend/App.tsx",
        "        setAuth({ phase: desktopMode ? 'desktopSetup' : 'setup' });",
        "        setAuth({ phase: desktopMode ? 'cloudflareSetup' : 'setup' });",
    )
    replace_once(
        "src/frontend/App.tsx",
        '''    } catch (error) {
      notify(error instanceof Error ? error.message : 'Uygulama başlatılamadı.', 'error');
      setAuth({ phase: 'login' });
    }''',
        '''    } catch (error) {
      notify(error instanceof Error ? error.message : 'Uygulama başlatılamadı.', 'error');
      setAuth({ phase: desktopMode ? 'cloudflareSetup' : 'login' });
    }''',
    )
    replace_once(
        "src/frontend/App.tsx",
        '''  if (auth.phase === 'desktopSetup') return <AuthCard title="İlk Kurulum Web Panelinde Yapılır" description="Güvenlik nedeniyle ilk yönetici hesabı ve kurulum anahtarı Windows uygulamasına girilemez. Önce WPAI web yönetim panelinde ilk yöneticiyi oluşturun; sonra bu uygulamada e-posta ve parolanızla giriş yapın."><button className="button secondary" onClick={() => void boot()}>Kurulum Durumunu Yeniden Kontrol Et</button></AuthCard>;
  if (auth.phase === 'setup') return <AuthCard title="İlk Yönetici Kurulumu" description="Yönetici hesabınızı oluşturun. Kurulum bir kez tamamlandıktan sonra bu ekran kapanır."><SetupForm onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>;
  if (auth.phase === 'login') return <AuthCard title="WPAI Yönetim Paneli" description={desktopMode ? 'Güvenli Windows oturumuyla giriş yapın' : 'WhatsApp görüşmeleri ve kontrollü AI yönetimi'}><LoginForm desktopMode={desktopMode} onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>;''',
        '''  if (auth.phase === 'cloudflareSetup') return <AuthCard title="WPAI İlk Kurulum" description="Cloudflare hesabını bağlayın. Uygulama eksikleri güvenli sınırlar içinde kuracak, ilk yönetici hesabını oluşturacak ve gerçek Windows girişini doğrulayacak."><CloudflareSetupForm onReady={admin => setAuth({ phase: 'ready', admin })} onLogin={() => setAuth({ phase: 'login' })} notify={notify} /></AuthCard>;
  if (auth.phase === 'setup') return <AuthCard title="İlk Yönetici Kurulumu" description="Yönetici hesabınızı oluşturun. Kurulum bir kez tamamlandıktan sonra bu ekran kapanır."><SetupForm onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>;
  if (auth.phase === 'login') return <AuthCard title="WPAI Yönetim Paneli" description={desktopMode ? 'Güvenli Windows oturumuyla giriş yapın' : 'WhatsApp görüşmeleri ve kontrollü AI yönetimi'}><LoginForm desktopMode={desktopMode} onCloudflareSetup={desktopMode ? () => setAuth({ phase: 'cloudflareSetup' }) : undefined} onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>;''',
    )
    replace_once(
        "src/frontend/App.tsx",
        "function SetupForm({ onReady, notify }: { onReady: (admin: Admin, csrf: string) => void; notify: Notify }) {",
        '''const CLOUDFLARE_ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';

function CloudflareSetupForm({ onReady, onLogin, notify }: { onReady: (admin: Admin) => void; onLogin: () => void; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('Cloudflare hesabı henüz bağlı değil.');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = formValue(form, 'password');
    const confirm = formValue(form, 'confirm');
    if (password !== confirm) { notify('Parolalar eşleşmiyor.', 'error'); return; }
    setBusy(true);
    setStage('Hesap doğrulanıyor, eksik kaynaklar kuruluyor ve WPAI dağıtılıyor…');
    try {
      const email = formValue(form, 'email');
      await desktop.cloudflareSetup({
        accountId: CLOUDFLARE_ACCOUNT_ID,
        apiToken: formValue(form, 'apiToken'),
        adminName: formValue(form, 'name'),
        adminEmail: email,
        adminPassword: password
      });
      setStage('Cloudflare hazır. Gerçek Windows oturumu doğrulanıyor…');
      const session = await desktopLogin(email, password);
      notify('Cloudflare bağlantısı, ilk yönetici hesabı ve Windows girişi başarıyla tamamlandı.', 'success');
      onReady(session.admin);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'WPAI ilk kurulumu tamamlanamadı.';
      setStage(message);
      notify(message, 'error');
    } finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="auth-form cloudflare-onboarding">
    <label>Cloudflare Account ID<input value={CLOUDFLARE_ACCOUNT_ID} readOnly /></label>
    <label>Sınırlı Cloudflare API Token<input name="apiToken" type="password" required minLength={30} autoComplete="off" placeholder="Token yalnız Windows Credential Manager'da saklanır" /></label>
    <label>Yönetici adı<input name="name" required minLength={2} /></label>
    <label>Yönetici e-postası / ID<input name="email" type="email" required autoComplete="username" /></label>
    <label>Yeni parola<input name="password" type="password" required minLength={12} autoComplete="new-password" /></label>
    <label>Parola tekrarı<input name="confirm" type="password" required minLength={12} autoComplete="new-password" /></label>
    <p className="safe-note">Token Worker'a, D1'e veya loglara yazılmaz. Yanlış D1 kimliği görülürse veri kaybını önlemek için kurulum durur.</p>
    <p role="status">{stage}</p>
    <button className="button primary" disabled={busy}>{busy ? 'Kurulum yapılıyor…' : 'Cloudflare’ı Bağla, Eksikleri Kur ve Giriş Yap'}</button>
    <button type="button" className="button secondary" disabled={busy} onClick={onLogin}>Mevcut Hesapla Giriş Yap</button>
  </form>;
}

function SetupForm({ onReady, notify }: { onReady: (admin: Admin, csrf: string) => void; notify: Notify }) {''',
    )
    replace_once(
        "src/frontend/App.tsx",
        "function LoginForm({ desktopMode, onReady, notify }: { desktopMode: boolean; onReady: (admin: Admin, csrf: string) => void; notify: Notify }) {",
        "function LoginForm({ desktopMode, onCloudflareSetup, onReady, notify }: { desktopMode: boolean; onCloudflareSetup?: () => void; onReady: (admin: Admin, csrf: string) => void; notify: Notify }) {",
    )
    replace_once(
        "src/frontend/App.tsx",
        '''  return <form onSubmit={submit} className="auth-form"><label>E-posta<input name="email" type="email" required autoComplete="username" /></label><label>Parola<input name="password" type="password" required minLength={12} autoComplete="current-password" /></label><button className="button primary" disabled={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}</button></form>;''',
        '''  return <form onSubmit={submit} className="auth-form"><label>E-posta<input name="email" type="email" required autoComplete="username" /></label><label>Parola<input name="password" type="password" required minLength={12} autoComplete="current-password" /></label><button className="button primary" disabled={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}</button>{desktopMode && onCloudflareSetup && <button type="button" className="button secondary" disabled={busy} onClick={onCloudflareSetup}>Cloudflare Kurulumu ve Onarımı</button>}</form>;''',
    )

    replace_once("src/frontend/pages/settings.tsx", "    if (isDesktop) return;\n    const form = event.currentTarget;", "    const form = event.currentTarget;")
    replace_once("src/frontend/pages/settings.tsx", "    if (isDesktop || !window.confirm('Kayıtlı Meta bilgileri kalıcı olarak silinsin mi?')) return;", "    if (!window.confirm('Kayıtlı Meta bilgileri kalıcı olarak silinsin mi?')) return;")
    replace_once(
        "src/frontend/pages/settings.tsx",
        '''  async function scan() {
    if (isDesktop) { notify('Cloudflare yönetim tokeni Windows uygulamasında kabul edilmez. Bu işlem web yönetim panelinden yapılmalıdır.', 'info'); return; }
    if (!token) { notify('Cloudflare API tokeni gerekli.', 'error'); return; }
    setBusy(true);
    try {
      const result = await api<InfraReport>('/api/cloudflare/scan', {
        method: 'POST', ...jsonBody({ accountId: ACCOUNT_ID, apiToken: token })
      });
      setInfra(result);
      notify(result.overall === 'ready' ? 'Cloudflare altyapısı hazır.' : 'Eksik veya yanlış ayarlar bulundu.', result.overall === 'ready' ? 'success' : 'info');
    } catch (error) { notify(error instanceof Error ? error.message : 'Tarama başarısız.', 'error'); }
    finally { setBusy(false); }
  }

  async function repair() {
    if (isDesktop || !infra || !token) return;
    const actions = infra.components.filter(item => item.status === 'missing' && item.repairable).map(item => item.key);
    if (!actions.length) { notify('Yalnız wa-ai-knowledge-prod veya wa-knowledge-index için güvenli oluşturma işi yok.', 'info'); return; }
    setBusy(true);
    try {
      const result = await api<{ report: InfraReport; applied: string[]; skipped: string[] }>('/api/cloudflare/repair', {
        method: 'POST', ...jsonBody({ accountId: ACCOUNT_ID, apiToken: token, actions })
      });
      setInfra(result.report);
      notify(`${result.applied.length} izinli Cloudflare bileşeni oluşturuldu.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Onarım tamamlanamadı.', 'error'); }
    finally { setBusy(false); }
  }''',
        '''  async function scan() {
    if (!isDesktop && !token) { notify('Cloudflare API tokeni gerekli.', 'error'); return; }
    setBusy(true);
    try {
      const result = isDesktop
        ? await desktop.cloudflareScan(ACCOUNT_ID, token || undefined) as unknown as { report: InfraReport }
        : { report: await api<InfraReport>('/api/cloudflare/scan', { method: 'POST', ...jsonBody({ accountId: ACCOUNT_ID, apiToken: token }) }) };
      setInfra(result.report);
      if (isDesktop && token) setToken('');
      notify(result.report.overall === 'ready' ? 'Cloudflare altyapısı hazır.' : 'Eksik veya yanlış ayarlar bulundu.', result.report.overall === 'ready' ? 'success' : 'info');
    } catch (error) { notify(error instanceof Error ? error.message : 'Tarama başarısız.', 'error'); }
    finally { setBusy(false); }
  }

  async function repair() {
    if (!infra) return;
    const actions = infra.components.filter(item => item.status === 'missing' && item.repairable).map(item => item.key);
    if (!actions.length) { notify('Güvenli biçimde oluşturulabilecek eksik Cloudflare bileşeni yok.', 'info'); return; }
    setBusy(true);
    try {
      const result = isDesktop
        ? await desktop.cloudflareRepair(ACCOUNT_ID, actions, token || undefined) as unknown as { report: InfraReport; applied: string[]; skipped: string[] }
        : await api<{ report: InfraReport; applied: string[]; skipped: string[] }>('/api/cloudflare/repair', { method: 'POST', ...jsonBody({ accountId: ACCOUNT_ID, apiToken: token, actions }) });
      setInfra(result.report);
      if (isDesktop && token) setToken('');
      notify(`${result.applied.length} izinli Cloudflare bileşeni oluşturuldu.`, 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Onarım tamamlanamadı.', 'error'); }
    finally { setBusy(false); }
  }

  async function forgetCloudflare() {
    if (!isDesktop || !window.confirm('Bu bilgisayardaki kayıtlı Cloudflare bağlantısı unutulsun mu?')) return;
    try {
      await desktop.cloudflareForget();
      setToken(''); setInfra(null);
      notify('Cloudflare API tokeni Windows Credential Manager’dan kaldırıldı.', 'success');
    } catch (error) { notify(error instanceof Error ? error.message : 'Cloudflare bağlantısı kaldırılamadı.', 'error'); }
  }''',
    )
    replace_once(
        "src/frontend/pages/settings.tsx",
        '''      {isDesktop ? <div className="summary-box"><strong>Masaüstü güvenlik sınırı</strong><p>Windows uygulaması Cloudflare API tokeni kabul etmez, saklamaz veya Worker’a iletmez. Kurulum/onarım yalnız web yönetim panelinden yapılır.</p></div> : <div className="form-grid"><label>Account ID<input value={ACCOUNT_ID} readOnly /></label><label className="wide">Sınırlı Cloudflare API Token<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" placeholder="Yalnız izinli WPAI kaynakları için" /></label><div className="form-actions wide"><button type="button" className="button secondary" onClick={() => setToken('')}>Tokeni Bellekten Sil</button><button type="button" className="button secondary" disabled={busy} onClick={() => void scan()}>{busy ? 'İşleniyor…' : 'Tam Sistem Taraması'}</button><button type="button" className="button primary" disabled={busy || !infra || infra.overall === 'ready'} onClick={() => void repair()}>Eksikleri Kur ve Onar</button></div></div>}
      <p className="safe-note">Web sürümünde token yalnız bu sayfanın belleğinde tutulur; D1, R2, log veya masaüstü credential alanına yazılmaz.</p>''',
        '''      <div className="form-grid"><label>Account ID<input value={ACCOUNT_ID} readOnly /></label><label className="wide">Sınırlı Cloudflare API Token<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" placeholder={isDesktop ? 'Yeni token girin veya kayıtlı bağlantıyı kullanın' : 'Yalnız izinli WPAI kaynakları için'} /></label><div className="form-actions wide"><button type="button" className="button secondary" onClick={() => setToken('')}>Giriş Alanını Temizle</button><button type="button" className="button secondary" disabled={busy} onClick={() => void scan()}>{busy ? 'İşleniyor…' : 'Tam Sistem Taraması'}</button><button type="button" className="button primary" disabled={busy || !infra || infra.overall === 'ready'} onClick={() => void repair()}>Eksikleri Kur ve Onar</button>{isDesktop && <button type="button" className="button danger-button" disabled={busy} onClick={() => void forgetCloudflare()}>Bu Bilgisayardaki Bağlantıyı Unut</button>}</div></div>
      <p className="safe-note">{isDesktop ? 'Doğrulanan token yalnız Windows Credential Manager’da tutulur; Worker’a, D1’e veya loglara yazılmaz.' : 'Web sürümünde token yalnız bu sayfanın belleğinde tutulur; D1, R2 veya loglara yazılmaz.'}</p>''',
    )
    replace_once(
        "src/frontend/pages/settings.tsx",
        '''    <section className="panel"><div className="panel-heading"><div><h3>WhatsApp Business API</h3><p>Meta bağlantısı ve gönderim durumu. Secret girişi Windows uygulamasında kapalıdır.</p></div><span className={`pill ${meta?.configured && meta.status === 'configured' ? 'ready' : 'warn'}`}>{meta?.configured ? meta.status : 'Bağlantı yok'}</span></div><div className="webhook"><span>Webhook URL</span><code>{webhook}</code><button className="text-button" onClick={() => void navigator.clipboard.writeText(webhook)}>Kopyala</button></div>
      {isDesktop ? <div className="summary-box"><strong>Secret girişi devre dışı</strong><p>Meta access token, app secret ve verify token masaüstü uygulamasına girilemez. Bağlantı bilgileri yalnız web yönetim panelinden şifreli biçimde kaydedilir.</p><div className="form-actions">{meta?.configured && meta.status === 'configured' && <button className="button secondary" onClick={() => void pauseMeta(true)}>Gönderimi Durdur</button>}{meta?.configured && meta.status === 'paused' && <button className="button secondary" onClick={() => void pauseMeta(false)}>Yeniden Aç</button>}</div></div> : <form className="form-grid" onSubmit={saveMeta}><label className="wide">Meta Access Token<input name="accessToken" type="password" required autoComplete="new-password" /></label><label>App Secret<input name="appSecret" type="password" required /></label><label>Webhook Verify Token<input name="verifyToken" type="password" required /></label><label>Phone Number ID<input name="phoneNumberId" required /></label><label>Business Account ID<input name="businessAccountId" required /></label><label className="wide">Yönetici WhatsApp numarası<input name="adminPhone" placeholder="+905…" /></label><div className="form-actions wide"><button className="button primary" disabled={busy}>Kaydet ve Bağlantıyı Doğrula</button>{meta?.configured && meta.status === 'configured' && <button type="button" className="button secondary" onClick={() => void pauseMeta(true)}>Bağlantıyı Durdur</button>}{meta?.configured && meta.status === 'paused' && <button type="button" className="button secondary" onClick={() => void pauseMeta(false)}>Yeniden Aç</button>}{meta?.configured && <button type="button" className="button danger-button" onClick={() => void removeMeta()}>Bilgileri Sil</button>}</div></form>}
    </section>''',
        '''    <section className="panel"><div className="panel-heading"><div><h3>WhatsApp Business API</h3><p>Meta bağlantı bilgileri uygulama içinden girilir, Worker’da şifrelenir ve gerçek Graph API isteğiyle doğrulanır.</p></div><span className={`pill ${meta?.configured && meta.status === 'configured' ? 'ready' : 'warn'}`}>{meta?.configured ? meta.status : 'Bağlantı yok'}</span></div><div className="webhook"><span>Webhook URL</span><code>{webhook}</code><button className="text-button" onClick={() => void navigator.clipboard.writeText(webhook)}>Kopyala</button></div>
      <form className="form-grid" onSubmit={saveMeta}><label className="wide">Meta Access Token<input name="accessToken" type="password" required autoComplete="new-password" /></label><label>App Secret<input name="appSecret" type="password" required /></label><label>Webhook Verify Token<input name="verifyToken" type="password" required /></label><label>Phone Number ID<input name="phoneNumberId" required /></label><label>Business Account ID<input name="businessAccountId" required /></label><label className="wide">Yönetici WhatsApp numarası<input name="adminPhone" placeholder="+905…" /></label><div className="form-actions wide"><button className="button primary" disabled={busy}>Kaydet ve Bağlantıyı Doğrula</button>{meta?.configured && meta.status === 'configured' && <button type="button" className="button secondary" onClick={() => void pauseMeta(true)}>Bağlantıyı Durdur</button>}{meta?.configured && meta.status === 'paused' && <button type="button" className="button secondary" onClick={() => void pauseMeta(false)}>Yeniden Aç</button>}{meta?.configured && <button type="button" className="button danger-button" onClick={() => void removeMeta()}>Bilgileri Sil</button>}</div></form>
    </section>''',
    )

    tauri = json.loads(read("src-tauri/tauri.conf.json"))
    tauri["version"] = "1.3.0"
    tauri["bundle"]["resources"] = {"../desktop-bootstrap/": "cloudflare-bootstrap/"}
    tauri["bundle"]["longDescription"] = "Cloudflare ilk kurulumunu, WhatsApp Business bağlantısını, müşteri görüşmelerini ve yapay zekâ yönetimini tek Windows uygulamasında güvenli biçimde yöneten WPAI istemcisi."
    write("src-tauri/tauri.conf.json", json.dumps(tauri, ensure_ascii=False, indent=2) + "\n")

    replace_once("src-tauri/Cargo.toml", 'version = "1.2.0"', 'version = "1.3.0"')
    package = json.loads(read("package.json"))
    package["version"] = "1.3.0"
    write("package.json", json.dumps(package, ensure_ascii=False, indent=2) + "\n")
    lock = json.loads(read("package-lock.json"))
    lock["version"] = "1.3.0"
    if "" in lock.get("packages", {}):
        lock["packages"][""]["version"] = "1.3.0"
    write("package-lock.json", json.dumps(lock, ensure_ascii=False, separators=(",", ":")) + "\n")
    replace_once("src/frontend/api.ts", "    appVersion: '1.2.0'", "    appVersion: '1.3.0'")

    replace_once(
        ".github/workflows/windows-desktop.yml",
        '''      - name: Build NSIS installer
        shell: pwsh
        run: npm run desktop:build''',
        '''      - name: Prepare packaged Cloudflare bootstrap runtime
        shell: pwsh
        run: |
          $ErrorActionPreference = 'Stop'
          $bootstrap = Join-Path $PWD 'desktop-bootstrap'
          $runtime = Join-Path $bootstrap 'runtime'
          $project = Join-Path $bootstrap 'project'
          Remove-Item $runtime, $project -Recurse -Force -ErrorAction SilentlyContinue
          New-Item -ItemType Directory -Force -Path $runtime, $project | Out-Null

          $nodeExe = (Get-Command node).Source
          $nodeHome = Split-Path -Parent $nodeExe
          Copy-Item $nodeExe (Join-Path $runtime 'node.exe')
          New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'node_modules') | Out-Null
          Copy-Item (Join-Path $nodeHome 'node_modules\\npm') (Join-Path $runtime 'node_modules\\npm') -Recurse

          $files = @('package.json','package-lock.json','wrangler.jsonc','index.html','vite.config.ts','tsconfig.base.json','tsconfig.frontend.json','tsconfig.worker.json','tsconfig.json')
          foreach ($file in $files) { Copy-Item (Join-Path $PWD $file) (Join-Path $project $file) }
          Copy-Item (Join-Path $PWD 'src') (Join-Path $project 'src') -Recurse
          Copy-Item (Join-Path $PWD 'migrations') (Join-Path $project 'migrations') -Recurse

          if (-not (Test-Path (Join-Path $bootstrap 'bootstrap.mjs'))) { throw 'Cloudflare bootstrap script missing' }
          if (-not (Test-Path (Join-Path $runtime 'node.exe'))) { throw 'Packaged Node runtime missing' }
          if (-not (Test-Path (Join-Path $runtime 'node_modules\\npm\\bin\\npm-cli.js'))) { throw 'Packaged npm runtime missing' }
          if (-not (Test-Path (Join-Path $project 'wrangler.jsonc'))) { throw 'Packaged Wrangler project missing' }
      - name: Build NSIS installer
        shell: pwsh
        run: npm run desktop:build''',
    )
    replace_once(
        ".github/workflows/windows-desktop.yml",
        '''          if (-not $installed) {
            Get-ChildItem -Path $installLocation -Filter *.exe -File -Recurse -Force -ErrorAction SilentlyContinue |
              Select-Object Name, Length, FullName |
              Format-Table -AutoSize
            throw "Installed application executable was not found in $installLocation"
          }

          $first = Start-Process''',
        '''          if (-not $installed) {
            Get-ChildItem -Path $installLocation -Filter *.exe -File -Recurse -Force -ErrorAction SilentlyContinue |
              Select-Object Name, Length, FullName |
              Format-Table -AutoSize
            throw "Installed application executable was not found in $installLocation"
          }

          $bootstrapScript = Get-ChildItem -Path $installLocation -Filter 'bootstrap.mjs' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
          $bootstrapNode = Get-ChildItem -Path $installLocation -Filter 'node.exe' -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'cloudflare-bootstrap' } | Select-Object -First 1
          $bootstrapProject = Get-ChildItem -Path $installLocation -Filter 'wrangler.jsonc' -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'cloudflare-bootstrap' } | Select-Object -First 1
          if (-not $bootstrapScript -or -not $bootstrapNode -or -not $bootstrapProject) {
            throw 'Installed Cloudflare first-run bootstrap resources are incomplete'
          }

          $first = Start-Process''',
    )
    replace_once(
        ".github/workflows/windows-desktop.yml",
        '''            installedExe = $installed.FullName
            firstInstanceAlive = $true''',
        '''            installedExe = $installed.FullName
            cloudflareBootstrapScript = $bootstrapScript.FullName
            cloudflareBootstrapNode = $bootstrapNode.FullName
            cloudflareBootstrapProject = $bootstrapProject.FullName
            firstInstanceAlive = $true''',
    )

    replace_once(
        "scripts/validate_spec500.py",
        '''    require("src-tauri/src/lib.rs", "tauri_plugin_single_instance::init", "pick_desktop_file", "show_desktop_notification", "faiss_replace")''',
        '''    require("src-tauri/src/lib.rs", "tauri_plugin_single_instance::init", "pick_desktop_file", "show_desktop_notification", "faiss_replace", "mod cloudflare")
    require("src-tauri/src/cloudflare.rs", "cloudflare_setup", "cloudflare_scan", "cloudflare_repair", "Windows Credential Manager")
    require("desktop-bootstrap/bootstrap.mjs", "D1_BLOCKED", "installAndDeploy", "createOrVerifyAdmin")
    require("src/frontend/App.tsx", "CloudflareSetupForm", "Cloudflare’ı Bağla, Eksikleri Kur ve Giriş Yap")
    require("src/frontend/pages/settings.tsx", "desktop.cloudflareScan", "desktop.cloudflareRepair", "desktop.cloudflareForget")''',
    )
    replace_once(
        "scripts/validate_spec500.py",
        '''        "windows-smoke.json",
    )''',
        '''        "windows-smoke.json",
        "Prepare packaged Cloudflare bootstrap runtime",
        "cloudflareBootstrapScript",
    )''',
    )
    replace_once(
        "scripts/validate_spec500.py",
        '''    if tauri["build"]["frontendDist"] != "../dist/web":
        raise AssertionError("Windows app must package the React build")''',
        '''    if tauri["build"]["frontendDist"] != "../dist/web":
        raise AssertionError("Windows app must package the React build")
    if tauri.get("bundle", {}).get("resources", {}).get("../desktop-bootstrap/") != "cloudflare-bootstrap/":
        raise AssertionError("Windows app must package the local Cloudflare bootstrap runtime")''',
    )

    gitignore = read(".gitignore")
    additions = "\n# Generated only during Windows packaging\ndesktop-bootstrap/runtime/\ndesktop-bootstrap/project/\n"
    if "desktop-bootstrap/runtime/" not in gitignore:
        write(".gitignore", gitignore.rstrip() + additions)

    print("Desktop onboarding patch applied.")


if __name__ == "__main__":
    main()
