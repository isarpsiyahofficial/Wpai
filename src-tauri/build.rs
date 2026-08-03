fn main() {
    const COMMANDS: &[&str] = &[
        "save_cloudflare_token",
        "load_cloudflare_token",
        "remove_cloudflare_token",
        "faiss_health",
        "faiss_upsert",
        "faiss_search",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    ).expect("Tauri build manifest could not be generated");
}
