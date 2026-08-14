import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ACCOUNT_ID = 'ad8e99c82c6c17d823f6877ff1efade4';
const D1_NAME = 'wa-ai-prod';
const WORKER_URL = (process.env.WPAI_WORKER_URL || 'https://wa-ai-panel.wa-ai-panel.workers.dev').replace(/\/$/, '');
const ROOT = process.env.WPAI_BOOTSTRAP_ROOT || process.cwd();
const PROJECT = process.env.WPAI_PROJECT_DIR || path.join(ROOT, 'project');
const RUNTIME_NODE = process.env.WPAI_NODE_PATH || path.join(ROOT, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const NPM_CLI = process.env.WPAI_NPM_CLI || path.join(ROOT, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const WRANGLER_BIN_OVERRIDE = process.env.WPAI_WRANGLER_BIN || '';
const SKIP_NPM = process.env.WPAI_BOOTSTRAP_SKIP_NPM === '1';
const COMMAND_TIMEOUT = Math.max(10_000, Number(process.env.WPAI_BOOTSTRAP_COMMAND_TIMEOUT_MS || 20 * 60_000));
const REQUEST_TIMEOUT = Math.max(2_000, Number(process.env.WPAI_BOOTSTRAP_REQUEST_TIMEOUT_MS || 30_000));
const VERSION = 'wrangler-oauth-device-v1';

function emit(body, code = 0) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exitCode = code;
}

function safe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 1800);
}

function fail(code, message, details) {
  const suffix = details ? ` ${safe(details)}` : '';
  throw new Error(`[${code}] ${message}${suffix}`);
}

function run(command, args, cwd = PROJECT, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
    timeout: COMMAND_TIMEOUT,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) fail('PROCESS_START_FAILED', `${path.basename(command)} başlatılamadı.`, result.error.message);
  return {
    status: result.status ?? 1,
    stdout: safe(result.stdout),
    stderr: safe(result.stderr)
  };
}

function requireFile(file, code, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(code, `${label} bulunamadı.`);
}

function npm(args) {
  requireFile(RUNTIME_NODE, 'PACKAGED_NODE_MISSING', 'Paketlenmiş Node çalışma zamanı');
  requireFile(NPM_CLI, 'PACKAGED_NPM_MISSING', 'Paketlenmiş npm çalışma zamanı');
  return run(RUNTIME_NODE, [NPM_CLI, ...args]);
}

function wranglerPath() {
  if (WRANGLER_BIN_OVERRIDE) return WRANGLER_BIN_OVERRIDE;
  return path.join(PROJECT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
}

function wrangler(args) {
  const bin = wranglerPath();
  requireFile(bin, 'WRANGLER_MISSING', 'Wrangler');
  return run(RUNTIME_NODE, [bin, ...args]);
}

function ensureDependencies() {
  if (SKIP_NPM) return;
  const lock = path.join(PROJECT, 'package-lock.json');
  const manifest = path.join(PROJECT, 'package.json');
  requireFile(lock, 'PROJECT_LOCK_MISSING', 'WPAI package-lock.json');
  requireFile(manifest, 'PROJECT_MANIFEST_MISSING', 'WPAI package.json');
  const installed = npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  if (installed.status !== 0) fail('NPM_CI_FAILED', 'WPAI bağlantı bileşenleri hazırlanamadı.', installed.stderr || installed.stdout);
}

function verifyWranglerOAuth() {
  const result = wrangler(['whoami']);
  if (result.status !== 0) {
    fail('WRANGLER_OAUTH_REQUIRED', 'Cloudflare oturumu bulunamadı veya yenilenemedi. Uygulamadaki “Cloudflare Oturumunu Aç” düğmesini kullanın.', result.stderr || result.stdout);
  }
  if (!result.stdout.includes(ACCOUNT_ID)) {
    fail('WRANGLER_ACCOUNT_MISMATCH', 'Wrangler farklı bir Cloudflare hesabına bağlı. WPAI proje hesabı seçilmelidir.');
  }
}

function applyMigrations() {
  const result = wrangler([
    'd1', 'migrations', 'apply', D1_NAME, '--remote',
    '--experimental-provision=false', '--experimental-auto-create=false'
  ]);
  if (result.status !== 0) fail('D1_MIGRATION_FAILED', 'Production D1 migrasyonları uygulanamadı.', result.stderr || result.stdout);
}

function buildAndDeploy() {
  const built = npm(['run', 'build']);
  if (built.status !== 0) fail('WEB_BUILD_FAILED', 'WPAI üretim arayüzü hazırlanamadı.', built.stderr || built.stdout);
  const deployed = wrangler(['deploy', '--strict', '--experimental-provision=false', '--experimental-auto-create=false']);
  if (deployed.status !== 0) fail('WORKER_DEPLOY_FAILED', 'WPAI Worker güncellenemedi.', deployed.stderr || deployed.stdout);
}

function activationTicket() {
  const token = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(token, 'utf8').digest('base64');
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
  const sql = `INSERT INTO desktop_activation_tokens (id,token_hash,bound_device_hash,status,expires_at,first_used_at,last_used_at,use_count,created_at) VALUES ('${id}','${hash}',NULL,'active','${expiresAt}',NULL,NULL,0,'${createdAt}');`;
  const inserted = wrangler([
    'd1', 'execute', D1_NAME, '--remote', '--command', sql,
    '--experimental-provision=false', '--experimental-auto-create=false'
  ]);
  if (inserted.status !== 0) fail('ACTIVATION_TICKET_CREATE_FAILED', 'Güvenli cihaz etkinleştirmesi oluşturulamadı.', inserted.stderr || inserted.stdout);
  return { id, token, expiresAt };
}

function deleteTicket(id) {
  const sql = `DELETE FROM desktop_activation_tokens WHERE id='${id.replaceAll("'", "")}' AND bound_device_hash IS NULL;`;
  wrangler(['d1', 'execute', D1_NAME, '--remote', '--command', sql, '--experimental-provision=false', '--experimental-auto-create=false']);
}

async function activateDevice(ticket, input) {
  let last = '';
  for (let attempt = 0; attempt < 18; attempt += 1) {
    try {
      const response = await fetch(`${WORKER_URL}/api/auth/desktop/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'tauri://localhost' },
        body: JSON.stringify({
          activationToken: ticket.token,
          deviceId: input.deviceId,
          deviceName: input.deviceName,
          appVersion: input.appVersion
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT)
      });
      const text = (await response.text()).slice(0, 500_000);
      last = `HTTP ${response.status} ${text.slice(0, 1000)}`;
      if (response.ok) {
        const body = JSON.parse(text);
        if (body?.ok === true && body?.data?.refreshToken && body?.data?.accessToken) return body.data;
      }
    } catch (error) {
      last = safe(error instanceof Error ? error.message : error);
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  deleteTicket(ticket.id);
  fail('DEVICE_ACTIVATION_FAILED', 'Production cihaz oturumu oluşturulamadı.', last);
}

function validInput(input) {
  return input && typeof input === 'object'
    && typeof input.deviceId === 'string' && input.deviceId.length >= 20 && input.deviceId.length <= 500 && !/\s/.test(input.deviceId)
    && typeof input.deviceName === 'string' && input.deviceName.trim().length >= 2 && input.deviceName.length <= 160
    && typeof input.appVersion === 'string' && input.appVersion.length >= 1 && input.appVersion.length <= 40;
}

async function login() {
  ensureDependencies();
  const result = wrangler(['login']);
  if (result.status !== 0) fail('WRANGLER_OAUTH_LOGIN_FAILED', 'Cloudflare tarayıcı oturumu tamamlanamadı.', result.stderr || result.stdout);
  verifyWranglerOAuth();
  return { ok: true, mode: 'wrangler_oauth', version: VERSION };
}

async function bootstrap(input) {
  if (!validInput(input)) fail('DEVICE_BOOTSTRAP_INVALID', 'Cihaz bağlantı isteği geçersiz.');
  ensureDependencies();
  verifyWranglerOAuth();
  applyMigrations();
  buildAndDeploy();
  const ticket = activationTicket();
  const session = await activateDevice(ticket, input);
  return {
    ok: true,
    mode: 'wrangler_oauth_device',
    version: VERSION,
    accountId: ACCOUNT_ID,
    session
  };
}

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); }
catch { input = null; }

try {
  if (input?.action === 'login') {
    emit(await login(), 0);
  } else if (input?.action === 'bootstrap') {
    emit(await bootstrap(input), 0);
  } else {
    fail('DEVICE_BOOTSTRAP_ACTION_INVALID', 'Geçersiz cihaz bağlantı işlemi.');
  }
} catch (error) {
  emit({ ok: false, error: safe(error instanceof Error ? error.message : error), version: VERSION }, 1);
}
