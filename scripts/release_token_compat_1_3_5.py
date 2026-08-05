from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OLD_VERSION = "1.3.4"
NEW_VERSION = "1.3.5"


def read(path: str) -> str:
    return (ROOT / path).read_text("utf-8")


def write(path: str, value: str) -> None:
    (ROOT / path).write_text(value, "utf-8")


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    value = read(path)
    count = value.count(old)
    if count != expected:
        raise SystemExit(f"Unexpected marker count in {path}: expected {expected}, found {count}: {old!r}")
    write(path, value.replace(old, new, expected))


old_verify = """async function verifyToken(token) {
  const verified = await cf(token, '/user/tokens/verify', {}, 'API token doğrulaması');
  if (verified?.status !== 'active') throw new Error(`Cloudflare API tokeni aktif değil (${verified?.status ?? 'durum bilinmiyor'}).`);
  return verified;
}
"""
new_verify = """function tokenVerificationRoutes(token) {
  if (token.startsWith('cfk_')) {
    throw new Error('Global API Key desteklenmiyor. Cloudflare User API Token veya Account API Token kullanın.');
  }
  if (token.startsWith('cfat_')) {
    return [{ type: 'account', route: `/accounts/${MANIFEST.accountId}/tokens/verify`, label: 'Account API Token doğrulaması' }];
  }
  if (token.startsWith('cfut_')) {
    return [{ type: 'user', route: '/user/tokens/verify', label: 'User API Token doğrulaması' }];
  }
  return [
    { type: 'user', route: '/user/tokens/verify', label: 'User API Token doğrulaması' },
    { type: 'account', route: `/accounts/${MANIFEST.accountId}/tokens/verify`, label: 'Account API Token doğrulaması' }
  ];
}

async function verifyToken(token) {
  const failures = [];
  for (const candidate of tokenVerificationRoutes(token)) {
    try {
      const verified = await cf(token, candidate.route, {}, candidate.label);
      if (verified?.status === 'active') return { ...verified, tokenType: candidate.type };
      failures.push(`${candidate.label}: token durumu ${verified?.status ?? 'bilinmiyor'}`);
    } catch (error) {
      failures.push(safeError(error));
    }
  }
  throw new Error(`Cloudflare API tokeni doğrulanamadı. User API Token ve Account API Token desteklenir. ${failures.join(' | ')}`);
}
"""
replace_exact("desktop-bootstrap/bootstrap.mjs", old_verify, new_verify)
replace_exact(
    "desktop-bootstrap/bootstrap.mjs",
    """    tokenStatus: verified.status,
    database: { name: database.name, id: database.uuid, ready: true },
""",
    """    tokenStatus: verified.status,
    tokenType: verified.tokenType,
    database: { name: database.name, id: database.uuid, ready: true },
""",
)
replace_exact(
    "desktop-bootstrap/bootstrap.mjs",
    "appVersion: '1.3.4'",
    "appVersion: '1.3.5'",
)

app_path = "src/frontend/App.tsx"
replace_exact(app_path, "Yeni Cloudflare API Token", "Yeni Cloudflare User veya Account API Token")
replace_exact(app_path, "Cloudflare API Token<input", "Cloudflare User veya Account API Token<input")
replace_exact(
    app_path,
    """<p className=\"safe-note wide\">Bağlantı doğrulandığında bu bilgisayarda güvenli biçimde saklanır. Uygulamayı kapatıp açtığınızda bağlı kalır.</p>""",
    """<p className=\"safe-note wide\">Cloudflare panelinde oluşturulan User API Token veya Account API Token kullanılabilir. Token ID ya da Global API Key kullanmayın. Bağlantı doğrulandığında bu bilgisayarda güvenli biçimde saklanır ve uygulama yeniden açıldığında bağlı kalır.</p>""",
)

# Add explicit account-owned token regression coverage.
test_path = "desktop-bootstrap/bootstrap.test.mjs"
replace_exact(
    test_path,
    "const TOKEN = 't'.repeat(48);",
    "const TOKEN = 't'.repeat(48);\nconst ACCOUNT_TOKEN = `cfat_${'a'.repeat(44)}`;\nconst GLOBAL_KEY = `cfk_${'g'.repeat(44)}`;",
)
insert_before = """test('invalid token returns the real Cloudflare error instead of a generic connection failure', async () => {
"""
account_test = """test('account-owned API token uses the account verification endpoint and completes setup', async () => {
  const requested = [];
  await withServer((request, response) => {
    requested.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === `/accounts/${ACCOUNT_ID}/tokens/verify`) return response.end(cloudflareSuccess({ status: 'active', id: 'account-token-id' }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}`) return response.end(cloudflareSuccess({ uuid: D1_ID, name: 'wa-ai-prod' }));
    if (request.url === '/health') return response.end(JSON.stringify({ ok: true, components: { worker: true, d1: true } }));
    if (request.url === `/accounts/${ACCOUNT_ID}/d1/database/${D1_ID}/query`) {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      return request.on('end', () => {
        const body = JSON.parse(raw);
        const results = body.sql.includes('COUNT(*)') ? [{ total: 0 }] : [];
        response.end(cloudflareSuccess([{ success: true, results, meta: { changes: body.sql.includes('INSERT INTO admins') ? 1 : 0 } }]));
      });
    }
    if (request.url === '/api/auth/desktop/login') return response.end(apiSuccess({
      admin: { id: 'admin-1', name: 'İbrahim', email: 'isarpsiyah@gmail.com', role: 'owner' },
      accessToken: 'a'.repeat(64), refreshToken: 'r'.repeat(64)
    }));
    if (request.url === '/api/auth/desktop/logout') return response.end(apiSuccess({ loggedOut: true }));
    response.statusCode = 404;
    response.end(JSON.stringify({ success: false, errors: [{ code: 404, message: 'unexpected route' }] }));
  }, async baseUrl => {
    const result = await runBootstrap(baseUrl, setupPayload({ apiToken: ACCOUNT_TOKEN }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.mode, 'connect_existing');
    assert.equal(result.body.report.tokenType, 'account');
    assert.equal(requested.includes('GET /user/tokens/verify'), false);
    assert.equal(requested.includes(`GET /accounts/${ACCOUNT_ID}/tokens/verify`), true);
  });
});

test('global API key is rejected before a Cloudflare request is attempted', async () => {
  const result = await runBootstrap('http://127.0.0.1:1', setupPayload({ apiToken: GLOBAL_KEY }));
  assert.notEqual(result.code, 0);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /Global API Key desteklenmiyor/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
});

"""
replace_exact(test_path, insert_before, account_test + insert_before)
replace_exact(
    test_path,
    "assert.match(result.body.error, /API token doğrulaması başarısız \\[10000\\]: Authentication error/);",
    "assert.match(result.body.error, /Cloudflare API tokeni doğrulanamadı/);\n    assert.match(result.body.error, /Authentication error/);",
)

# Synchronize all release version markers.
package_path = ROOT / "package.json"
package = json.loads(package_path.read_text("utf-8"))
if package.get("version") != OLD_VERSION:
    raise SystemExit(f"Unexpected package version: {package.get('version')}")
package["version"] = NEW_VERSION
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", "utf-8")

lock_path = ROOT / "package-lock.json"
lock = json.loads(lock_path.read_text("utf-8"))
if lock.get("version") != OLD_VERSION or lock.get("packages", {}).get("", {}).get("version") != OLD_VERSION:
    raise SystemExit("package-lock root version is not 1.3.4")
lock["version"] = NEW_VERSION
lock["packages"][""]["version"] = NEW_VERSION
lock_path.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", "utf-8")

config_path = ROOT / "src-tauri/tauri.conf.json"
config = json.loads(config_path.read_text("utf-8"))
if config.get("version") != OLD_VERSION:
    raise SystemExit(f"Unexpected Tauri version: {config.get('version')}")
config["version"] = NEW_VERSION
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", "utf-8")

for path in ("src-tauri/Cargo.toml", "src-tauri/Cargo.lock"):
    value = read(path)
    pattern = rf'(?m)^(name = "wpai-desktop"\nversion = "){re.escape(OLD_VERSION)}("$)'
    value, count = re.subn(pattern, rf"\g<1>{NEW_VERSION}\g<2>", value, count=1)
    if count != 1:
        raise SystemExit(f"Root package version marker not found in {path}")
    write(path, value)

replace_exact("src/frontend/api.ts", "appVersion: '1.3.4'", "appVersion: '1.3.5'")
replace_exact("scripts/validate_spec500.py", 'version != "1.3.4"', 'version != "1.3.5"')
replace_exact("scripts/validate_spec500.py", 'Expected final audited version 1.3.4', 'Expected final audited version 1.3.5')

required_markers = {
    "desktop-bootstrap/bootstrap.mjs": [
        "/accounts/${MANIFEST.accountId}/tokens/verify",
        "tokenType: candidate.type",
        "User API Token ve Account API Token desteklenir",
        "appVersion: '1.3.5'",
    ],
    "desktop-bootstrap/bootstrap.test.mjs": [
        "account-owned API token uses the account verification endpoint",
        "global API key is rejected",
        "result.body.report.tokenType, 'account'",
    ],
    "src/frontend/App.tsx": [
        "Cloudflare User veya Account API Token",
        "Token ID ya da Global API Key kullanmayın",
    ],
    "package.json": ['"version": "1.3.5"'],
    "src-tauri/tauri.conf.json": ['"version": "1.3.5"'],
}
for path, markers in required_markers.items():
    value = read(path)
    for marker in markers:
        if marker not in value:
            raise SystemExit(f"Required marker missing in {path}: {marker}")

print("WPAI 1.3.5 user/account token compatibility and regression tests applied.")
