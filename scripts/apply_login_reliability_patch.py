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
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:120]!r}")
    write(path, value.replace(old, new, 1))


def main() -> None:
    # Password policy: user-selected passwords may be any six or more characters.
    replace_once(
        "src/shared/contracts.ts",
        "  password: z.string().min(12).max(256)\n});\n\nexport const SetupAdminSchema",
        "  password: z.string().min(1).max(256)\n});\n\nexport const SetupAdminSchema",
    )
    replace_once(
        "src/shared/contracts.ts",
        "  password: z.string().min(12).max(256),\n  bootstrapToken:",
        "  password: z.string().min(6).max(256),\n  bootstrapToken:",
    )
    replace_once(
        "src/shared/contracts.ts",
        "  newPassword: z.string().min(12).max(256),",
        "  newPassword: z.string().min(6).max(256),",
    )
    replace_once(
        "src/worker/crypto.ts",
        "  if (password.length < 12) errors.push('Parola en az 12 karakter olmalıdır.');\n  if (!/[a-zçğıöşü]/u.test(password)) errors.push('En az bir küçük harf gereklidir.');\n  if (!/[A-ZÇĞİÖŞÜ]/u.test(password)) errors.push('En az bir büyük harf gereklidir.');\n  if (!/\\d/.test(password)) errors.push('En az bir rakam gereklidir.');",
        "  if (password.length < 6) errors.push('Parola en az 6 karakter olmalıdır.');",
    )

    # Authentication screens must always show errors instead of appearing unresponsive.
    replace_once(
        "src/frontend/App.tsx",
        '''  if (auth.phase === 'loading') return <Centered><div className="loader" /><p>Güvenli panel hazırlanıyor…</p></Centered>;
  if (auth.phase === 'cloudflareSetup') return <AuthCard title="WPAI İlk Kurulum" description="Cloudflare hesabını bağlayın. Uygulama eksikleri güvenli sınırlar içinde kuracak, ilk yönetici hesabını oluşturacak ve gerçek Windows girişini doğrulayacak."><CloudflareSetupForm onReady={admin => setAuth({ phase: 'ready', admin })} onLogin={() => setAuth({ phase: 'login' })} notify={notify} /></AuthCard>;
  if (auth.phase === 'setup') return <AuthCard title="İlk Yönetici Kurulumu" description="Yönetici hesabınızı oluşturun. Kurulum bir kez tamamlandıktan sonra bu ekran kapanır."><SetupForm onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>;
  if (auth.phase === 'login') return <AuthCard title="WPAI Yönetim Paneli" description={desktopMode ? 'Güvenli Windows oturumuyla giriş yapın' : 'WhatsApp görüşmeleri ve kontrollü AI yönetimi'}><LoginForm desktopMode={desktopMode} onCloudflareSetup={desktopMode ? () => setAuth({ phase: 'cloudflareSetup' }) : undefined} onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>;''',
        '''  const authToast = toast && <div className={`toast ${toast.kind}`} role="status" aria-live="assertive">{toast.message}</div>;
  if (auth.phase === 'loading') return <><Centered><div className="loader" /><p>Güvenli panel hazırlanıyor…</p></Centered>{authToast}</>;
  if (auth.phase === 'cloudflareSetup') return <><AuthCard title="WPAI İlk Kurulum" description="Cloudflare hesabını bağlayın. Uygulama eksikleri güvenli sınırlar içinde kuracak, ilk yönetici hesabını oluşturacak ve gerçek Windows girişini doğrulayacak."><CloudflareSetupForm onReady={admin => setAuth({ phase: 'ready', admin })} onLogin={() => setAuth({ phase: 'login' })} notify={notify} /></AuthCard>{authToast}</>;
  if (auth.phase === 'setup') return <><AuthCard title="İlk Yönetici Kurulumu" description="Yönetici hesabınızı oluşturun. Kurulum bir kez tamamlandıktan sonra bu ekran kapanır."><SetupForm onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>{authToast}</>;
  if (auth.phase === 'login') return <><AuthCard title="WPAI Yönetim Paneli" description={desktopMode ? 'Güvenli Windows oturumuyla giriş yapın' : 'WhatsApp görüşmeleri ve kontrollü AI yönetimi'}><LoginForm desktopMode={desktopMode} onCloudflareSetup={desktopMode ? () => setAuth({ phase: 'cloudflareSetup' }) : undefined} onReady={(admin, csrf) => { setCsrfToken(csrf); setAuth({ phase: 'ready', admin }); }} notify={notify} /></AuthCard>{authToast}</>;''',
    )
    replace_once(
        "src/frontend/App.tsx",
        "      const session = await desktopLogin(email, password);\n      notify('Cloudflare bağlantısı, ilk yönetici hesabı ve Windows girişi başarıyla tamamlandı.', 'success');",
        "      const session = await desktopLogin(email, password);\n      await api('/api/dashboard');\n      notify('Cloudflare bağlantısı, yönetici hesabı ve otomatik Windows girişi başarıyla tamamlandı.', 'success');",
    )
    replace_once(
        "src/frontend/App.tsx",
        '''    <label>Yeni parola<input name="password" type="password" required minLength={12} autoComplete="new-password" /></label>
    <label>Parola tekrarı<input name="confirm" type="password" required minLength={12} autoComplete="new-password" /></label>''',
        '''    <label>Yeni parola<input name="password" type="password" required minLength={6} autoComplete="new-password" /></label>
    <label>Parola tekrarı<input name="confirm" type="password" required minLength={6} autoComplete="new-password" /></label>''',
    )
    replace_once(
        "src/frontend/App.tsx",
        '''<label>Yeni parola<input name="password" type="password" required minLength={12} /></label><label>Parola tekrarı<input name="confirm" type="password" required minLength={12} /></label>''',
        '''<label>Yeni parola<input name="password" type="password" required minLength={6} /></label><label>Parola tekrarı<input name="confirm" type="password" required minLength={6} /></label>''',
    )
    replace_once(
        "src/frontend/App.tsx",
        "  const [busy, setBusy] = useState(false);\n  async function submit(event: FormEvent<HTMLFormElement>) {\n    event.preventDefault();\n    const form = event.currentTarget;\n    const email = formValue(form, 'email');\n    const password = formValue(form, 'password');\n    setBusy(true);",
        "  const [busy, setBusy] = useState(false);\n  const [errorMessage, setErrorMessage] = useState('');\n  async function submit(event: FormEvent<HTMLFormElement>) {\n    event.preventDefault();\n    const form = event.currentTarget;\n    const email = formValue(form, 'email');\n    const password = formValue(form, 'password');\n    setErrorMessage('');\n    setBusy(true);",
    )
    replace_once(
        "src/frontend/App.tsx",
        "    } catch (error) { notify(error instanceof Error ? error.message : 'Giriş başarısız.', 'error'); }\n    finally { setBusy(false); }\n  }\n  return <form onSubmit={submit} className=\"auth-form\"><label>E-posta<input name=\"email\" type=\"email\" required autoComplete=\"username\" /></label><label>Parola<input name=\"password\" type=\"password\" required minLength={12} autoComplete=\"current-password\" /></label><button className=\"button primary\" disabled={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}</button>{desktopMode && onCloudflareSetup && <button type=\"button\" className=\"button secondary\" disabled={busy} onClick={onCloudflareSetup}>Cloudflare Kurulumu ve Onarımı</button>}</form>;",
        "    } catch (error) {\n      const message = error instanceof Error ? error.message : 'Giriş başarısız.';\n      setErrorMessage(message);\n      notify(message, 'error');\n    }\n    finally { setBusy(false); }\n  }\n  return <form onSubmit={submit} className=\"auth-form\"><label>E-posta<input name=\"email\" type=\"email\" required autoComplete=\"username\" /></label><label>Parola<input name=\"password\" type=\"password\" required minLength={1} autoComplete=\"current-password\" /></label>{errorMessage && <p className=\"safe-note\" role=\"alert\" aria-live=\"assertive\">{errorMessage}</p>}<button className=\"button primary\" disabled={busy}>{busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}</button>{desktopMode && onCloudflareSetup && <button type=\"button\" className=\"button secondary\" disabled={busy} onClick={onCloudflareSetup}>Cloudflare Kurulumu ve Onarımı</button>}</form>;",
    )
    replace_once(
        "src/frontend/pages/settings.tsx",
        '''<label>Yeni parola<input name="next" type="password" minLength={12} required /></label><label>Yeni parola tekrarı<input name="confirm" type="password" minLength={12} required /></label>''',
        '''<label>Yeni parola<input name="next" type="password" minLength={6} required /></label><label>Yeni parola tekrarı<input name="confirm" type="password" minLength={6} required /></label>''',
    )

    # Existing installations must update/reset the owner selected in the setup screen.
    replace_once(
        "desktop-bootstrap/bootstrap.mjs",
        "    if (typeof input.adminPassword !== 'string' || input.adminPassword.length < 12 || input.adminPassword.length > 256) throw new Error('Yönetici parolası en az 12 karakter olmalıdır.');\n    if (!/[a-zçğıöşü]/u.test(input.adminPassword) || !/[A-ZÇĞİÖŞÜ]/u.test(input.adminPassword) || !/\\d/.test(input.adminPassword)) {\n      throw new Error('Yönetici parolası küçük harf, büyük harf ve rakam içermelidir.');\n    }",
        "    if (typeof input.adminPassword !== 'string' || input.adminPassword.length < 6 || input.adminPassword.length > 256) throw new Error('Yönetici parolası en az 6 karakter olmalıdır.');",
    )
    old_admin = '''async function createOrVerifyAdmin(input, bootstrapToken) {
  const status = await workerRequest('/api/auth/setup-status');
  if (status.required) {
    await workerRequest('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.adminName.trim(),
        email: input.adminEmail.trim().toLowerCase(),
        password: input.adminPassword,
        bootstrapToken
      })
    });
  }

  const deviceId = `wpai-bootstrap-${crypto.randomBytes(24).toString('hex')}`;
  const session = await workerRequest('/api/auth/desktop/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tauri.localhost' },
    body: JSON.stringify({
      email: input.adminEmail.trim().toLowerCase(),
      password: input.adminPassword,
      deviceId,
      deviceName: 'WPAI Windows Kurulum Doğrulaması',
      appVersion: '1.3.0'
    })
  });
  if (!session?.accessToken || !session?.refreshToken || session.admin?.email !== input.adminEmail.trim().toLowerCase()) {
    throw new Error('Windows yönetici giriş doğrulaması başarısız.');
  }
  await workerRequest('/api/auth/desktop/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tauri.localhost' },
    body: JSON.stringify({ refreshToken: session.refreshToken, deviceId })
  });
  return { id: session.admin.id, name: session.admin.name, email: session.admin.email, role: session.admin.role, created: status.required };
}'''
    new_admin = '''function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function encodedPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256');
  return `pbkdf2-sha256$310000$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function provisionOwnerAccess(input, token) {
  const { project, node, wrangler } = runtimePaths();
  const env = commandEnvironment(token, path.dirname(node));
  if (!fs.existsSync(wrangler)) throw new Error('Paketlenmiş Wrangler bulunamadı.');
  const now = new Date().toISOString();
  const email = input.adminEmail.trim().toLowerCase();
  const name = input.adminName.trim();
  const passwordHash = encodedPasswordHash(input.adminPassword);
  const emailHash = crypto.createHash('sha256').update(email).digest('base64');
  const adminId = crypto.randomUUID();
  const sqlPath = path.join(project, `.wpai-owner-${crypto.randomUUID()}.sql`);
  const sql = `
PRAGMA foreign_keys = ON;
INSERT INTO admins
  (id, name, email, password_hash, role, status, failed_login_count, locked_until, created_at, updated_at, deleted_at)
VALUES
  (${sqlLiteral(adminId)}, ${sqlLiteral(name)}, ${sqlLiteral(email)}, ${sqlLiteral(passwordHash)}, 'owner', 'active', 0, NULL, ${sqlLiteral(now)}, ${sqlLiteral(now)}, NULL)
ON CONFLICT(email) DO UPDATE SET
  name = excluded.name,
  password_hash = excluded.password_hash,
  role = 'owner',
  status = 'active',
  failed_login_count = 0,
  locked_until = NULL,
  updated_at = excluded.updated_at,
  deleted_at = NULL;
UPDATE admins
   SET status = 'disabled', deleted_at = COALESCE(deleted_at, ${sqlLiteral(now)}), updated_at = ${sqlLiteral(now)}
 WHERE role = 'owner' AND email <> ${sqlLiteral(email)} AND deleted_at IS NULL;
UPDATE admin_sessions SET revoked_at = ${sqlLiteral(now)} WHERE revoked_at IS NULL;
UPDATE desktop_sessions SET revoked_at = ${sqlLiteral(now)} WHERE revoked_at IS NULL;
UPDATE desktop_devices
   SET status = 'active', revoked_at = NULL, last_seen_at = ${sqlLiteral(now)}
 WHERE admin_id = (SELECT id FROM admins WHERE email = ${sqlLiteral(email)} LIMIT 1);
DELETE FROM login_attempts WHERE email_hash = ${sqlLiteral(emailHash)};
`;
  fs.writeFileSync(sqlPath, sql, { mode: 0o600 });
  try {
    run(node, [wrangler, 'd1', 'execute', MANIFEST.d1, '--remote', '--file', sqlPath, '--experimental-provision=false', '--experimental-auto-create=false'], {
      cwd: project, env, label: 'Yönetici hesabının oluşturulması veya güncellenmesi', timeout: 10 * 60_000
    });
  } finally {
    fs.rmSync(sqlPath, { force: true });
  }
}

async function createOrVerifyAdmin(input, bootstrapToken, token) {
  const status = await workerRequest('/api/auth/setup-status');
  let created = false;
  let reconfigured = false;
  if (status.required) {
    try {
      await workerRequest('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: input.adminName.trim(),
          email: input.adminEmail.trim().toLowerCase(),
          password: input.adminPassword,
          bootstrapToken
        })
      });
      created = true;
    } catch (error) {
      if (!safeError(error).startsWith('SETUP_CLOSED:')) throw error;
      provisionOwnerAccess(input, token);
      reconfigured = true;
    }
  } else {
    provisionOwnerAccess(input, token);
    reconfigured = true;
  }

  const deviceId = `wpai-bootstrap-${crypto.randomBytes(24).toString('hex')}`;
  const session = await workerRequest('/api/auth/desktop/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tauri.localhost' },
    body: JSON.stringify({
      email: input.adminEmail.trim().toLowerCase(),
      password: input.adminPassword,
      deviceId,
      deviceName: 'WPAI Windows Kurulum Doğrulaması',
      appVersion: '1.3.1'
    })
  });
  if (!session?.accessToken || !session?.refreshToken || session.admin?.email !== input.adminEmail.trim().toLowerCase()) {
    throw new Error('Windows yönetici giriş doğrulaması başarısız.');
  }
  await workerRequest('/api/auth/desktop/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tauri.localhost' },
    body: JSON.stringify({ refreshToken: session.refreshToken, deviceId })
  });
  return { id: session.admin.id, name: session.admin.name, email: session.admin.email, role: session.admin.role, created, reconfigured };
}'''
    replace_once("desktop-bootstrap/bootstrap.mjs", old_admin, new_admin)
    replace_once(
        "desktop-bootstrap/bootstrap.mjs",
        '''    const generatedSecrets = {
      SESSION_SIGNING_KEY: crypto.randomBytes(48).toString('base64url'),
      DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      ADMIN_BOOTSTRAP_TOKEN: crypto.randomBytes(48).toString('base64url')
    };
    secretsToRedact.push(...Object.values(generatedSecrets));
    installAndDeploy(input.apiToken, generatedSecrets);
    await waitForWorker();
    const admin = await createOrVerifyAdmin(input, generatedSecrets.ADMIN_BOOTSTRAP_TOKEN);''',
        '''    let existingInstallation = false;
    try {
      const currentSetup = await workerRequest('/api/auth/setup-status');
      existingInstallation = currentSetup.required === false;
    } catch { /* Worker may not exist before the first installation. */ }
    const generatedSecrets = existingInstallation ? {} : {
      SESSION_SIGNING_KEY: crypto.randomBytes(48).toString('base64url'),
      DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      ADMIN_BOOTSTRAP_TOKEN: crypto.randomBytes(48).toString('base64url')
    };
    secretsToRedact.push(...Object.values(generatedSecrets));
    installAndDeploy(input.apiToken, generatedSecrets);
    await waitForWorker();
    const admin = await createOrVerifyAdmin(input, generatedSecrets.ADMIN_BOOTSTRAP_TOKEN ?? '', input.apiToken);''',
    )

    # Release Windows binary as GUI subsystem so no console/CMD window is attached.
    write(
        "src-tauri/src/main.rs",
        '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]\n\nfn main() { wpai_desktop_lib::run(); }\n',
    )

    # Version 1.3.1 across all package manifests and runtime reports.
    package = json.loads(read("package.json"))
    package["version"] = "1.3.1"
    write("package.json", json.dumps(package, ensure_ascii=False, indent=2) + "\n")
    lock = json.loads(read("package-lock.json"))
    lock["version"] = "1.3.1"
    lock["packages"][""]["version"] = "1.3.1"
    write("package-lock.json", json.dumps(lock, ensure_ascii=False, indent=2) + "\n")
    replace_once("src-tauri/Cargo.toml", 'version = "1.3.0"', 'version = "1.3.1"')
    replace_once(
        "src-tauri/Cargo.lock",
        '[[package]]\nname = "wpai-desktop"\nversion = "1.3.0"',
        '[[package]]\nname = "wpai-desktop"\nversion = "1.3.1"',
    )
    tauri = json.loads(read("src-tauri/tauri.conf.json"))
    tauri["version"] = "1.3.1"
    write("src-tauri/tauri.conf.json", json.dumps(tauri, ensure_ascii=False, indent=2) + "\n")
    replace_once("src/frontend/api.ts", "    appVersion: '1.3.0'", "    appVersion: '1.3.1'")

    # Regression tests and static gates for all four reported failures.
    replace_once(
        "tests/unit/contracts.test.ts",
        "    expect(() => SetupAdminSchema.parse({ name: 'A', email: 'bad', password: 'short', bootstrapToken: 'x' })).toThrow();",
        "    expect(() => SetupAdminSchema.parse({ name: 'A', email: 'bad', password: 'short', bootstrapToken: 'x' })).toThrow();\n    expect(SetupAdminSchema.parse({ name: 'İbrahim', email: 'owner@example.com', password: '123456', bootstrapToken: 'x'.repeat(24) }).password).toBe('123456');",
    )
    replace_once(
        "tests/worker/auth.test.ts",
        "body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'YeniGüvenliParola456', revokeOtherSessions: true })",
        "body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: '654321', revokeOtherSessions: true })",
    )
    replace_once(
        "tests/worker/auth.test.ts",
        "body: JSON.stringify({ email: TEST_EMAIL, password: 'YeniGüvenliParola456' })",
        "body: JSON.stringify({ email: TEST_EMAIL, password: '654321' })",
    )
    replace_once(
        "scripts/validate_spec500.py",
        '    require("src-tauri/src/cloudflare.rs", "cloudflare_setup", "cloudflare_scan", "cloudflare_repair", "Windows Credential Manager")',
        '    require("src-tauri/src/cloudflare.rs", "cloudflare_setup", "cloudflare_scan", "cloudflare_repair", "Windows Credential Manager")\n    require("src-tauri/src/main.rs", "windows_subsystem = \\"windows\\"")',
    )
    replace_once(
        "scripts/validate_spec500.py",
        '    require("desktop-bootstrap/bootstrap.mjs", "D1_BLOCKED", "installAndDeploy", "createOrVerifyAdmin")',
        '    require("desktop-bootstrap/bootstrap.mjs", "D1_BLOCKED", "installAndDeploy", "createOrVerifyAdmin", "provisionOwnerAccess", "length < 6")',
    )
    replace_once(
        "scripts/validate_spec500.py",
        '    require("src/frontend/App.tsx", "CloudflareSetupForm", "Cloudflare’ı Bağla, Eksikleri Kur ve Giriş Yap")',
        '    require("src/frontend/App.tsx", "CloudflareSetupForm", "Cloudflare’ı Bağla, Eksikleri Kur ve Giriş Yap", "authToast", "errorMessage")',
    )

    print("Login reliability, six-character password policy and silent Windows patch applied.")


if __name__ == "__main__":
    main()
