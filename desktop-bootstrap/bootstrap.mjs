import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MANIFEST = Object.freeze({
  accountId: 'ad8e99c82c6c17d823f6877ff1efade4',
  worker: 'wa-ai-panel',
  workerUrl: 'https://wa-ai-panel.wa-ai-panel.workers.dev',
  d1: 'wa-ai-prod',
  d1Id: '81983219-f57b-487b-8144-7c70bf9b1fe2',
  r2: 'wa-ai-files-prod',
  queues: ['wa-inbound-ai', 'wa-outbound', 'wa-admin-notify', 'wa-ai-dlq', 'wa-outbound-dlq', 'wa-knowledge-index'],
  vectorize: 'wa-ai-knowledge-prod',
  vectorDimensions: 1024,
  vectorMetric: 'cosine'
});

const MAX_RESPONSE_BYTES = 2_000_000;

function safeError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) message = message.replaceAll(secret, '[REDACTED]');
  }
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1500);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 128_000) throw new Error('Kurulum isteği çok büyük.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw || '{}');
}

function validateInput(input) {
  if (!['scan', 'repair', 'setup'].includes(input.action)) throw new Error('Geçersiz Cloudflare kurulum işlemi.');
  if (input.accountId !== MANIFEST.accountId) throw new Error('Cloudflare Account ID proje hesabıyla eşleşmiyor.');
  if (typeof input.apiToken !== 'string' || input.apiToken.length < 30 || input.apiToken.length > 4096 || /\s/.test(input.apiToken)) {
    throw new Error('Cloudflare API tokeni geçersiz.');
  }
  if (input.action === 'setup') {
    if (typeof input.adminName !== 'string' || input.adminName.trim().length < 2 || input.adminName.length > 120) throw new Error('Yönetici adı geçersiz.');
    if (typeof input.adminEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.adminEmail) || input.adminEmail.length > 254) throw new Error('Yönetici e-postası geçersiz.');
    if (typeof input.adminPassword !== 'string' || input.adminPassword.length < 6 || input.adminPassword.length > 256) throw new Error('Yönetici parolası en az 6 karakter olmalıdır.');
  }
}

async function cf(token, route, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    },
    signal: AbortSignal.timeout(45_000)
  });
  const text = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok || !body?.success) {
    const code = body?.errors?.[0]?.code ?? response.status;
    const message = body?.errors?.[0]?.message ?? 'Cloudflare isteği başarısız.';
    throw new Error(`CLOUDFLARE_${code}: ${message}`);
  }
  return body.result;
}

function rows(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value[key])) return value[key];
  return [];
}

async function scan(token) {
  const verified = await cf(token, '/user/tokens/verify');
  if (verified?.status !== 'active') throw new Error('Cloudflare API tokeni aktif değil.');
  const account = await cf(token, `/accounts/${MANIFEST.accountId}`);
  if (account?.id !== MANIFEST.accountId) throw new Error('Cloudflare hesabı proje hesabıyla eşleşmiyor.');

  const [d1Raw, r2Raw, queuesRaw, scriptsRaw, vectorRaw] = await Promise.all([
    cf(token, `/accounts/${MANIFEST.accountId}/d1/database?per_page=100`),
    cf(token, `/accounts/${MANIFEST.accountId}/r2/buckets?per_page=100`),
    cf(token, `/accounts/${MANIFEST.accountId}/queues?per_page=100`),
    cf(token, `/accounts/${MANIFEST.accountId}/workers/scripts?per_page=100`),
    cf(token, `/accounts/${MANIFEST.accountId}/vectorize/v2/indexes?per_page=100`)
  ]);

  const databases = rows(d1Raw, 'databases');
  const buckets = rows(r2Raw, 'buckets');
  const queues = rows(queuesRaw, 'queues').map(item => ({ id: item.queue_id ?? item.id, name: item.queue_name ?? item.name }));
  const scripts = rows(scriptsRaw, 'scripts');
  const indexes = rows(vectorRaw, 'indexes');
  const components = [];

  const databaseByName = databases.find(item => item.name === MANIFEST.d1);
  const databaseById = databases.find(item => item.uuid === MANIFEST.d1Id);
  const d1Ready = databaseByName?.uuid === MANIFEST.d1Id && databaseById?.name === MANIFEST.d1;
  components.push({
    key: 'd1', label: 'D1 veritabanı',
    status: d1Ready ? 'ready' : databaseByName || databaseById ? 'misconfigured' : 'missing',
    current: databaseByName ? `${databaseByName.name} / ${databaseByName.uuid}` : databaseById ? `${databaseById.name} / ${databaseById.uuid}` : undefined,
    expected: `${MANIFEST.d1} / ${MANIFEST.d1Id}`,
    repairable: false,
    details: d1Ready ? undefined : 'Production D1 kimliği otomatik değiştirilmez. Yanlış veya eksik D1 veri kaybı riski nedeniyle kurulumu durdurur.'
  });

  const bucket = buckets.find(item => item.name === MANIFEST.r2);
  components.push({ key: 'r2', label: 'R2 özel dosya alanı', status: bucket ? 'ready' : 'missing', current: bucket?.name, expected: MANIFEST.r2, repairable: !bucket });

  for (const name of MANIFEST.queues) {
    const queue = queues.find(item => item.name === name);
    components.push({ key: `queue:${name}`, label: `Queue: ${name}`, status: queue ? 'ready' : 'missing', current: queue?.id, expected: name, repairable: !queue });
  }

  const worker = scripts.find(item => (item.id ?? item.name) === MANIFEST.worker);
  components.push({ key: 'worker', label: 'Worker uygulaması', status: worker ? 'ready' : 'missing', current: worker?.id ?? worker?.name, expected: MANIFEST.worker, repairable: true });

  const vector = indexes.find(item => item.name === MANIFEST.vectorize);
  const vectorReady = Boolean(vector && vector.config?.dimensions === MANIFEST.vectorDimensions && (vector.config?.metric ?? MANIFEST.vectorMetric) === MANIFEST.vectorMetric);
  components.push({
    key: 'vectorize', label: 'Vectorize bilgi indeksi',
    status: !vector ? 'missing' : vectorReady ? 'ready' : 'misconfigured',
    current: vector ? `${vector.name} / ${vector.config?.dimensions ?? '?'} / ${vector.config?.metric ?? '?'}` : undefined,
    expected: `${MANIFEST.vectorize} / ${MANIFEST.vectorDimensions} / ${MANIFEST.vectorMetric}`,
    repairable: !vector,
    details: vector && !vectorReady ? 'Yanlış boyutlu Vectorize indeksi silinmez veya üzerine yazılmaz.' : undefined
  });

  const blocked = components.some(item => item.status === 'misconfigured' || (item.key === 'd1' && item.status !== 'ready'));
  return {
    accountId: MANIFEST.accountId,
    accountName: account.name,
    checkedAt: new Date().toISOString(),
    overall: components.every(item => item.status === 'ready') ? 'ready' : blocked ? 'blocked' : 'repair_required',
    components,
    plan: components.filter(item => item.status !== 'ready').map(item => ({
      action: item.repairable ? (item.key === 'worker' ? 'deploy' : 'create') : 'review',
      resource: item.key,
      destructive: false,
      paid: false
    }))
  };
}

async function createMissingResources(token, report, selectedActions) {
  const selected = selectedActions?.length ? new Set(selectedActions) : null;
  const applied = [];
  const skipped = [];
  for (const item of report.components) {
    if (item.status !== 'missing' || !item.repairable || item.key === 'worker') continue;
    if (selected && !selected.has(item.key)) continue;
    if (item.key === 'r2') {
      await cf(token, `/accounts/${MANIFEST.accountId}/r2/buckets`, { method: 'POST', body: JSON.stringify({ name: MANIFEST.r2 }) });
      applied.push(item.key);
      continue;
    }
    if (item.key.startsWith('queue:')) {
      const queueName = item.key.slice('queue:'.length);
      if (!MANIFEST.queues.includes(queueName)) { skipped.push(item.key); continue; }
      await cf(token, `/accounts/${MANIFEST.accountId}/queues`, { method: 'POST', body: JSON.stringify({ queue_name: queueName }) });
      applied.push(item.key);
      continue;
    }
    if (item.key === 'vectorize') {
      await cf(token, `/accounts/${MANIFEST.accountId}/vectorize/v2/indexes`, {
        method: 'POST',
        body: JSON.stringify({ name: MANIFEST.vectorize, config: { dimensions: MANIFEST.vectorDimensions, metric: MANIFEST.vectorMetric } })
      });
      applied.push(item.key);
      continue;
    }
    skipped.push(item.key);
  }
  return { applied, skipped };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim().slice(-2500);
    throw new Error(`${options.label ?? path.basename(command)} başarısız (${result.status ?? 'unknown'}): ${detail}`);
  }
  return result.stdout || '';
}

function runtimePaths() {
  const root = process.env.WPAI_BOOTSTRAP_ROOT;
  const project = process.env.WPAI_PROJECT_DIR;
  if (!root || !project) throw new Error('Windows kurulum çalışma alanı bulunamadı.');
  const node = path.join(root, 'runtime', 'node.exe');
  const npmCli = path.join(root, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const wrangler = path.join(project, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  for (const required of [node, npmCli]) if (!fs.existsSync(required)) throw new Error(`Kurulum çalışma zamanı eksik: ${path.basename(required)}`);
  return { root, project, node, npmCli, wrangler };
}

function commandEnvironment(token, runtimeDir) {
  return {
    ...process.env,
    PATH: `${runtimeDir};${process.env.PATH || ''}`,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: MANIFEST.accountId,
    CI: 'true',
    NO_COLOR: '1'
  };
}

function installAndDeploy(token, secrets) {
  const { project, node, npmCli, wrangler } = runtimePaths();
  const runtimeDir = path.dirname(node);
  const env = commandEnvironment(token, runtimeDir);
  run(node, [npmCli, 'ci', '--no-audit', '--no-fund'], { cwd: project, env, label: 'Kilitli uygulama bağımlılıklarının kurulumu', timeout: 20 * 60_000 });
  if (!fs.existsSync(wrangler)) throw new Error('Paketlenmiş Wrangler kurulamadı.');
  run(node, [npmCli, 'run', 'build'], { cwd: project, env, label: 'WPAI production build', timeout: 10 * 60_000 });
  run(node, [wrangler, 'd1', 'migrations', 'apply', MANIFEST.d1, '--remote', '--experimental-provision=false', '--experimental-auto-create=false'], {
    cwd: project, env, label: 'Production D1 migrationları', timeout: 10 * 60_000
  });
  run(node, [wrangler, 'deploy', '--strict', '--experimental-provision=false', '--experimental-auto-create=false'], {
    cwd: project, env, label: 'Cloudflare Worker dağıtımı', timeout: 15 * 60_000
  });
  for (const [name, value] of Object.entries(secrets)) {
    run(node, [wrangler, 'secret', 'put', name, '--name', MANIFEST.worker], {
      cwd: project, env, input: `${value}\n`, label: `${name} secret kurulumu`, timeout: 5 * 60_000
    });
  }
}

async function workerRequest(route, init = {}) {
  const response = await fetch(`${MANIFEST.workerUrl}${route}`, { ...init, signal: AbortSignal.timeout(45_000) });
  const text = (await response.text()).slice(0, 1_000_000);
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok || body?.ok === false) {
    throw new Error(`${body?.error?.code ?? `HTTP_${response.status}`}: ${body?.error?.message ?? 'WPAI Worker isteği başarısız.'}`);
  }
  return body?.data ?? body;
}

async function waitForWorker() {
  let lastError = 'Worker henüz hazır değil.';
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await fetch(`${MANIFEST.workerUrl}/health`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      if (response.ok && body?.ok && body?.components?.worker && body?.components?.d1) return body;
      lastError = `Health HTTP ${response.status}`;
    } catch (error) { lastError = safeError(error); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error(`Cloudflare Worker sağlık kontrolü geçmedi: ${lastError}`);
}

function sqlLiteral(value) {
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
      appVersion: '1.3.2'
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
}

async function main() {
  const input = await readInput();
  validateInput(input);
  const secretsToRedact = [input.apiToken, input.adminPassword];
  try {
    const before = await scan(input.apiToken);
    if (input.action === 'scan') {
      output({ ok: true, action: 'scan', report: before });
      return;
    }
    if (before.components.find(item => item.key === 'd1')?.status !== 'ready') {
      throw new Error('D1_BLOCKED: wa-ai-prod veritabanı beklenen production kimliğiyle bulunamadı. Veri kaybı riski nedeniyle otomatik yeni D1 oluşturulmadı.');
    }
    if (before.components.some(item => item.status === 'misconfigured')) {
      throw new Error('Cloudflare hesabında otomatik değiştirilemeyecek yanlış yapılandırma bulundu.');
    }

    const changes = await createMissingResources(input.apiToken, before, input.actions);
    const afterResources = await scan(input.apiToken);
    if (input.action === 'repair') {
      output({ ok: true, action: 'repair', applied: changes.applied, skipped: changes.skipped, report: afterResources });
      return;
    }

    const requiredAfterRepair = afterResources.components.filter(item => item.key !== 'worker' && item.status !== 'ready');
    if (requiredAfterRepair.length) throw new Error(`Cloudflare kaynak kurulumu tamamlanamadı: ${requiredAfterRepair.map(item => item.label).join(', ')}`);

    let existingInstallation = false;
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
    const admin = await createOrVerifyAdmin(input, generatedSecrets.ADMIN_BOOTSTRAP_TOKEN ?? '', input.apiToken);
    const finalReport = await scan(input.apiToken);
    output({
      ok: true,
      action: 'setup',
      checkedAt: new Date().toISOString(),
      accountId: MANIFEST.accountId,
      workerUrl: MANIFEST.workerUrl,
      applied: changes.applied,
      admin,
      report: finalReport
    });
  } catch (error) {
    output({ ok: false, error: safeError(error, secretsToRedact) });
    process.exitCode = 1;
  }
}

main().catch(error => {
  output({ ok: false, error: safeError(error) });
  process.exitCode = 1;
});
