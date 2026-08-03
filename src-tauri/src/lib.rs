use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
};
use tauri_plugin_shell::ShellExt;

const KEYRING_SERVICE: &str = "WPAI Desktop Session";
const KEYRING_USER: &str = "refresh-token";
const FAISS_DIMENSION: usize = 1024;
const MAX_FAISS_VECTORS: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPreferences {
    close_to_tray: bool,
    autostart_enabled: bool,
    notifications_enabled: bool,
    notification_redact: bool,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            autostart_enabled: false,
            notifications_enabled: true,
            notification_redact: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FaissVectorItem {
    id: String,
    vector: Vec<f32>,
    metadata: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FaissMatch {
    id: String,
    score: f32,
    metadata: Value,
}

fn validate_refresh_token(token: &str) -> Result<(), String> {
    if !(32..=1000).contains(&token.len()) || token.chars().any(char::is_whitespace) {
        return Err("Masaüstü oturum anahtarı geçersiz.".into());
    }
    Ok(())
}

fn validate_device_seed(seed: &str) -> Result<(), String> {
    if !(20..=160).contains(&seed.len())
        || !seed
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.'))
    {
        return Err("Masaüstü cihaz kimliği geçersiz.".into());
    }
    Ok(())
}

fn validate_source_checksum(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.chars().all(|item| item.is_ascii_hexdigit()) {
        return Err("Yerel indeks kaynak checksum değeri geçersiz.".into());
    }
    Ok(())
}

fn validate_vector(vector: &[f32]) -> Result<(), String> {
    if vector.len() != FAISS_DIMENSION
        || vector.iter().any(|value| !value.is_finite())
        || vector.iter().all(|value| *value == 0.0)
    {
        return Err("FAISS vektörü 1024 boyutlu, sonlu ve sıfırdan farklı olmalıdır.".into());
    }
    Ok(())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Uygulama veri klasörü bulunamadı.".to_string())?;
    fs::create_dir_all(&dir).map_err(|_| "Uygulama veri klasörü oluşturulamadı.".to_string())?;
    Ok(dir)
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("desktop-preferences.json"))
}

fn load_preferences(app: &AppHandle) -> DesktopPreferences {
    let Ok(path) = preferences_path(app) else {
        return DesktopPreferences::default();
    };
    let Ok(bytes) = fs::read(path) else {
        return DesktopPreferences::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save_preferences(app: &AppHandle, value: &DesktopPreferences) -> Result<(), String> {
    let path = preferences_path(app)?;
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(value).map_err(|_| "Masaüstü tercihleri hazırlanamadı.".to_string())?;
    fs::write(&temp, bytes).map_err(|_| "Masaüstü tercihleri yazılamadı.".to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|_| "Eski masaüstü tercihleri değiştirilemedi.".to_string())?;
    }
    fs::rename(temp, path).map_err(|_| "Masaüstü tercihleri etkinleştirilemedi.".to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn get_or_create_device_id(app: AppHandle, seed: String) -> Result<String, String> {
    validate_device_seed(&seed)?;
    let path = app_data_dir(&app)?.join("device-id");
    if path.exists() {
        let existing = fs::read_to_string(&path)
            .map_err(|_| "Masaüstü cihaz kimliği okunamadı.".to_string())?;
        let existing = existing.trim().to_string();
        validate_device_seed(&existing)?;
        return Ok(existing);
    }
    let temp = path.with_extension("tmp");
    fs::write(&temp, seed.as_bytes()).map_err(|_| "Masaüstü cihaz kimliği yazılamadı.".to_string())?;
    match fs::rename(&temp, &path) {
        Ok(()) => Ok(seed),
        Err(_) if path.exists() => {
            let _ = fs::remove_file(temp);
            let existing = fs::read_to_string(path)
                .map_err(|_| "Masaüstü cihaz kimliği okunamadı.".to_string())?;
            let existing = existing.trim().to_string();
            validate_device_seed(&existing)?;
            Ok(existing)
        }
        Err(_) => Err("Masaüstü cihaz kimliği etkinleştirilemedi.".into()),
    }
}

#[tauri::command]
fn save_desktop_refresh_token(token: String) -> Result<(), String> {
    validate_refresh_token(&token)?;
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "Windows Credential Manager açılamadı.".to_string())?
        .set_password(&token)
        .map_err(|_| "Masaüstü oturumu Windows Credential Manager'a kaydedilemedi.".to_string())
}

#[tauri::command]
fn load_desktop_refresh_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "Windows Credential Manager açılamadı.".to_string())?;
    match entry.get_password() {
        Ok(value) => {
            validate_refresh_token(&value)?;
            Ok(Some(value))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Kayıtlı masaüstü oturumu okunamadı.".to_string()),
    }
}

#[tauri::command]
fn remove_desktop_refresh_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|_| "Windows Credential Manager açılamadı.".to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Masaüstü oturumu kaldırılamadı.".to_string()),
    }
}

#[tauri::command]
fn desktop_preferences(state: State<'_, Mutex<DesktopPreferences>>) -> Result<DesktopPreferences, String> {
    state
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "Masaüstü tercihleri kilitlendi.".to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn set_desktop_preferences(
    app: AppHandle,
    state: State<'_, Mutex<DesktopPreferences>>,
    preferences: DesktopPreferences,
) -> Result<DesktopPreferences, String> {
    save_preferences(&app, &preferences)?;
    let mut current = state
        .lock()
        .map_err(|_| "Masaüstü tercihleri kilitlendi.".to_string())?;
    *current = preferences.clone();
    Ok(preferences)
}

#[cfg(target_os = "windows")]
fn configure_windows_autostart(enabled: bool) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|_| "WPAI uygulama yolu bulunamadı.".to_string())?;
    let quoted = format!("\"{}\"", executable.display());
    let mut command = Command::new("reg");
    if enabled {
        command.args([
            "add",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "WPAI",
            "/t",
            "REG_SZ",
            "/d",
            &quoted,
            "/f",
        ]);
    } else {
        command.args([
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "WPAI",
            "/f",
        ]);
    }
    let output = command
        .output()
        .map_err(|_| "Windows başlangıç ayarı çalıştırılamadı.".to_string())?;
    if output.status.success() || (!enabled && output.status.code() == Some(1)) {
        Ok(())
    } else {
        Err("Windows başlangıç ayarı güncellenemedi.".into())
    }
}

#[cfg(not(target_os = "windows"))]
fn configure_windows_autostart(_enabled: bool) -> Result<(), String> {
    Err("Otomatik başlangıç yalnız Windows'ta desteklenir.".into())
}

#[tauri::command(rename_all = "camelCase")]
fn set_windows_autostart(
    app: AppHandle,
    state: State<'_, Mutex<DesktopPreferences>>,
    enabled: bool,
) -> Result<DesktopPreferences, String> {
    configure_windows_autostart(enabled)?;
    let mut current = state
        .lock()
        .map_err(|_| "Masaüstü tercihleri kilitlendi.".to_string())?;
    current.autostart_enabled = enabled;
    save_preferences(&app, &current)?;
    Ok(current.clone())
}

#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Ana pencere bulunamadı.".to_string())?;
    window.show().map_err(|_| "Ana pencere açılamadı.".to_string())?;
    window.set_focus().map_err(|_| "Ana pencere odaklanamadı.".to_string())
}

#[tauri::command]
fn quit_application(app: AppHandle) {
    app.exit(0);
}

fn faiss_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("faiss-index");
    fs::create_dir_all(&dir).map_err(|_| "FAISS veri klasörü oluşturulamadı.".to_string())?;
    Ok(dir)
}

async fn run_sidecar(app: &AppHandle, args: Vec<String>) -> Result<Value, String> {
    let output = app
        .shell()
        .sidecar("faiss-service")
        .map_err(|_| "FAISS sidecar hazırlanamadı.".to_string())?
        .args(args)
        .output()
        .await
        .map_err(|_| "FAISS sidecar çalıştırılamadı.".to_string())?;
    if !output.status.success() {
        let safe = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(500)
            .collect::<String>();
        return Err(format!("FAISS işlemi başarısız: {safe}"));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "FAISS cevabı okunamadı.".to_string())
}

fn temp_json(app: &AppHandle, prefix: &str, value: &Value) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = app
        .path()
        .temp_dir()
        .map_err(|_| "Geçici klasör bulunamadı.".to_string())?
        .join(format!("{prefix}-{}-{stamp}.json", std::process::id()));
    fs::write(
        &path,
        serde_json::to_vec(value).map_err(|_| "FAISS verisi hazırlanamadı.".to_string())?,
    )
    .map_err(|_| "Geçici FAISS dosyası yazılamadı.".to_string())?;
    Ok(path)
}

async fn run_with_input(app: &AppHandle, command: &str, value: Value) -> Result<Value, String> {
    let db = faiss_db_path(app)?;
    let input = temp_json(app, &format!("wpai-faiss-{command}"), &value)?;
    let result = run_sidecar(
        app,
        vec![
            command.into(),
            "--db".into(),
            db.to_string_lossy().into_owned(),
            "--input".into(),
            input.to_string_lossy().into_owned(),
        ],
    )
    .await;
    let _ = fs::remove_file(input);
    result
}

fn validate_faiss_item(item: &FaissVectorItem) -> Result<(), String> {
    if item.id.trim().is_empty() || item.id.len() > 256 {
        return Err("FAISS kayıt kimliği geçersiz.".into());
    }
    validate_vector(&item.vector)?;
    let metadata_size = serde_json::to_vec(&item.metadata)
        .map_err(|_| "FAISS metadata değeri okunamadı.".to_string())?
        .len();
    if metadata_size > 250_000 {
        return Err("FAISS metadata değeri çok büyük.".into());
    }
    Ok(())
}

#[tauri::command]
async fn faiss_health(app: AppHandle) -> Result<Value, String> {
    run_sidecar(&app, vec!["health".into()]).await
}

#[tauri::command]
async fn faiss_status(app: AppHandle) -> Result<Value, String> {
    let db = faiss_db_path(&app)?;
    run_sidecar(
        &app,
        vec!["status".into(), "--db".into(), db.to_string_lossy().into_owned()],
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn faiss_replace(
    app: AppHandle,
    source_checksum: String,
    vectors: Vec<FaissVectorItem>,
) -> Result<Value, String> {
    validate_source_checksum(&source_checksum)?;
    if vectors.len() > MAX_FAISS_VECTORS {
        return Err("Yerel indeks tek senkronizasyonda en fazla 10.000 vektör kabul eder.".into());
    }
    for item in &vectors {
        validate_faiss_item(item)?;
    }
    run_with_input(
        &app,
        "replace",
        serde_json::json!({ "sourceChecksum": source_checksum, "vectors": vectors }),
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn faiss_upsert(
    app: AppHandle,
    id: String,
    vector: Vec<f32>,
    metadata: Value,
) -> Result<Value, String> {
    let item = FaissVectorItem { id, vector, metadata };
    validate_faiss_item(&item)?;
    run_with_input(&app, "upsert", serde_json::json!([item])).await
}

#[tauri::command]
async fn faiss_delete(app: AppHandle, ids: Vec<String>) -> Result<Value, String> {
    if ids.is_empty()
        || ids.len() > 1000
        || ids
            .iter()
            .any(|id| id.trim().is_empty() || id.len() > 256)
    {
        return Err("FAISS silme listesi geçersiz.".into());
    }
    run_with_input(&app, "delete", serde_json::json!({ "ids": ids })).await
}

#[tauri::command(rename_all = "camelCase")]
async fn faiss_search(
    app: AppHandle,
    vector: Vec<f32>,
    top_k: usize,
    threshold: f32,
) -> Result<Vec<FaissMatch>, String> {
    validate_vector(&vector)?;
    if !threshold.is_finite() || !(-1.0..=1.0).contains(&threshold) {
        return Err("FAISS arama eşiği geçersiz.".into());
    }
    let value = run_with_input(
        &app,
        "search",
        serde_json::json!({ "vector": vector, "topK": top_k.clamp(1, 20), "threshold": threshold }),
    )
    .await?;
    serde_json::from_value(value).map_err(|_| "FAISS arama sonucu okunamadı.".to_string())
}

#[tauri::command]
async fn faiss_clear(app: AppHandle) -> Result<Value, String> {
    let db = faiss_db_path(&app)?;
    run_sidecar(
        &app,
        vec!["clear".into(), "--db".into(), db.to_string_lossy().into_owned()],
    )
    .await
}

fn build_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "WPAI'ı Aç", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Tamamen Çık", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("WPAI");
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            if let Some(window) = tray.app_handle().get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    })
    .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(DesktopPreferences::default()))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let loaded = load_preferences(app.handle());
            if let Ok(mut state) = app.state::<Mutex<DesktopPreferences>>().lock() {
                *state = loaded;
            }
            build_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = window
                    .state::<Mutex<DesktopPreferences>>()
                    .lock()
                    .map(|value| value.close_to_tray)
                    .unwrap_or(true);
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_or_create_device_id,
            save_desktop_refresh_token,
            load_desktop_refresh_token,
            remove_desktop_refresh_token,
            desktop_preferences,
            set_desktop_preferences,
            set_windows_autostart,
            show_main_window,
            quit_application,
            faiss_health,
            faiss_status,
            faiss_replace,
            faiss_upsert,
            faiss_delete,
            faiss_search,
            faiss_clear
        ])
        .run(tauri::generate_context!())
        .expect("WPAI masaüstü uygulaması başlatılamadı");
}

#[cfg(test)]
mod tests {
    use super::{
        validate_device_seed, validate_refresh_token, validate_source_checksum, validate_vector,
        FAISS_DIMENSION,
    };

    #[test]
    fn accepts_only_opaque_refresh_tokens() {
        assert!(validate_refresh_token(&"a".repeat(32)).is_ok());
        assert!(validate_refresh_token(&"a".repeat(1000)).is_ok());
        assert!(validate_refresh_token("too-short").is_err());
        assert!(validate_refresh_token(&format!("{} ", "a".repeat(40))).is_err());
    }

    #[test]
    fn device_id_is_stable_safe_text_only() {
        assert!(validate_device_seed("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_device_seed("bad path/with/slash").is_err());
        assert!(validate_device_seed("short").is_err());
    }

    #[test]
    fn local_index_requires_bge_m3_dimensions() {
        let mut vector = vec![0.0; FAISS_DIMENSION];
        vector[0] = 1.0;
        assert!(validate_vector(&vector).is_ok());
        assert!(validate_vector(&[1.0, 0.0]).is_err());
        assert!(validate_vector(&vec![0.0; FAISS_DIMENSION]).is_err());
    }

    #[test]
    fn source_checksum_is_exact_sha256_hex() {
        assert!(validate_source_checksum(&"a".repeat(64)).is_ok());
        assert!(validate_source_checksum(&"g".repeat(64)).is_err());
        assert!(validate_source_checksum("short").is_err());
    }

    #[test]
    fn desktop_permissions_contain_no_provider_secrets() {
        let permissions = include_str!("../permissions/default.toml").to_ascii_lowercase();
        assert!(!permissions.contains("cloudflare_token"));
        assert!(!permissions.contains("meta_access"));
        assert!(permissions.contains("save_desktop_refresh_token"));
        let capability = include_str!("../capabilities/local.json").to_ascii_lowercase();
        assert!(!capability.contains("workers.dev"));
        assert!(!capability.contains("remote"));
    }
}
