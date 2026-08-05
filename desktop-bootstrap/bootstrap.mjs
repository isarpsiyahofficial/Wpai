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

const TEST_MODE = process.env.WPAI_BOOTSTRAP_TEST_MODE === '1';
const API_BASE = TEST_MODE && process.env.WPAI_CLOUDFLARE_API_BASE
  ? process.env.WPAI_CLOUDFLARE_API_BASE.replace(/\/$/, '')
  : 'https://api.cloudflare.com/client/v4';
const WORKER_URL = TEST_MODE && process.env.WPAI_WORKER_URL
  ? process.env.WPAI_WORKER_URL.replace(/\/$/, '')
  : MANIFEST.workerUrl;
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
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function validateInput(input) {
  if (!['scan', 'repair', 'setup'].includes(input.action)) throw new Error('Geçersiz Cloudflare bağlantı işlemi.');
  if (input.accountId !== MANIFEST.accountId) throw new Error('Cloudflare hesabı WPAI proje hesabıyla eşleşmiyor.');
  if (typeof input.apiToken !== 'string' || input.apiToken.length < 30 || input.apiToken.length > 4096 || /\s/.test(input.apiToken)) {
    throw new Error('Cloudflare API tokeni geçersiz biçimde. Tokeni başında veya sonunda boşluk olmadan yeniden girin.');
  }
  if (input.action === 'setup') {
    if (typeof input.adminName !== 'string' || input.adminName.trim().length < 2 || input.adminName.length > 120) throw new Error('Yönetici adı geçersiz.');
    if (typeof input.adminEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.adminEmail) || input.adminEmail.length > 254) throw new Error('Yönetici e-postası geçersiz.');
    if (typeof input.adminPassword !== 'string' || input.adminPassword.length < 6 || input.adminPassword.length > 256) throw new Error('Yönetici parolası en az 6 karakter olmalıdır.');
  }
}

async function cf(token, route, init = {}, label = 'Cloudflare isteği') {
  let response;
  try {
    response = await fetch(`${API_BASE}${route}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {})
      },
      signal: AbortSignal.timeout(45_000)
    });
  } catch (error) {
    throw new Error(`${label} Cloudflare'a ulaşılamadığı için tamamlanamadı: ${safeError(error)}`);
  }
  const text = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok || !body?.success) {
    const code = body?.errors?.[0]?.code ?? response.status;
    const message = body?.errors?.[0]?.message ?? `HTTP ${response.status}`;
    throw new Error(`${label} başarısız [${code}]: ${message}`);
  }
  return body.result;
}

async function verifyToken(token) {
  const verified = await cf(token, '/user/tokens/verify', {}, 'API token doğrulaması');
  if (verified?.status !== 'active') throw new Error(`Cloudflare API tokeni aktif değil (${verified?.status ?? 'durum bilinmiyor'}).`);
  return verified;
}

async function verifyProductionD1(token) {
  let database;
  try {
    database = await cf(
      token,
      `/accounts/${MANIFEST.accountId}/d1/database/${MANIFEST.d1Id}`,
      {},
      'WPAI D1 erişim kontrolü'
    );
  } catch (error) {
    throw new Error(`Cloudflare tokeni doğrulandı ancak WPAI veritabanına erişemiyor. Token izinlerinde “D1 Read” ve ilk yönetici kurulumu için “D1 Write” bulunmalıdır. ${safeError(error)}`);
  }
  if (database?.uuid !== MANIFEST.d1Id || database?.name !== MANIFEST.d1) {
    throw new Error('wa-ai-prod veritabanı beklenen production kimliğiyle eşleşmiyor. Veri kaybı riski nedeniyle işlem durduruldu.');
  }
  return database;
}

async function d1Query(token, sql, params = []) {
  const result = await cf(
    token,
    `/accounts/${MANIFEST.accountId}/d1/database/${MANIFEST.d1Id}/query`,
    { method: 'POST', body: JSON.stringify({ sql, params }) },
    'WPAI D1 sorgusu'
  );
  const entries = Array.isArray(result) ? result : [];
  if (!entries.length || entries.some(item => item?.success === false)) throw new Error('WPAI D1 sorgusu Cloudflare tarafından tamamlanamadı.');
  return entries;
}

async function workerRequest(route, init = {}) {
  let response;
  try {
    response = await fetch(`${WORKER_URL}${route}`, { ...init, signal: AbortSignal.timeout(45_000) });
  } catch (error) {
    throw new Error(`WPAI Worker'a ulaşılamadı: ${safeError(error)}`);
  }
  const text = (await response.text()).slice(0, 1_000_000);
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok || body?.ok === false) {
    throw new Error(`${body?.error?.code ?? `HTTP_${response.status}`}: ${body?.error?.message ?? 'WPAI Worker isteği başarısız.'}`);
  }
  return body?.data ?? body;
}

async function readWorkerHealth() {
  let response;
  try {
    response = await fetch(`${WORKER_URL}/health`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new Error(`WPAI Worker sağlık adresine ulaşılamadı: ${safeError(error)}`);
  }
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || !body?.ok || !body?.components?.worker || !body?.components?.d1) {
    const components = body?.components ? JSON.stringify(body.components) : `HTTP ${response.status}`;
    throw new Error(`WPAI Worker hazır değil: ${components}`);
  }
  return body;
}

async function tryWorkerHealth() {
  try { return { ready: true, health: await readWorkerHealth(), error: null }; }
  catch (error) { return { ready: false, health: null, error: safeError(error) }; }
}

function rows(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value[key])) return value[key];
  return [];
}

async function probe(label, permission, action) {
  try { return { ok: true, value: await action() }; }
  catch (error) { return { ok: false, error: safeError(error), label, permission }; }
}

async function fullScan(token) {
  await verifyToken(token);
  const database = await verifyProductionD1(token);
  const [r2Probe, queuesProbe, scriptsProbe, vectorProbe] = await Promise.all([
    probe('R2 dosya alanı', 'Workers R2 Storage Read/Edit', () => cf(token, `/accounts/${MANIFEST.accountId}/r2/buckets?per_page=100`, {}, 'R2 listeleme')),
    probe('Cloudflare Queues', 'Queues Read/Edit', () => cf(token, `/accounts/${MANIFEST.accountId}/queues?per_page=100`, {}, 'Queue listeleme')),
    probe('Worker uygulaması', 'Workers Scripts Read/Edit', () => cf(token, `/accounts/${MANIFEST.accountId}/workers/scripts?per_page=100`, {}, 'Worker listeleme')),
    probe('Vectorize bilgi indeksi', 'Vectorize Read/Edit', () => cf(token, `/accounts/${MANIFEST.accountId}/vectorize/v2/indexes?per_page=100`, {}, 'Vectorize listeleme'))
  ]);

  const components = [{
    key: 'd1', label: 'D1 veritabanı', status: 'ready',
    current: `${database.name} / ${database.uuid}`, expected: `${MANIFEST.d1} / ${MANIFEST.d1Id}`, repairable: false
  }];
  const permissionErrors = [];

  if (!r2Probe.ok) {
    permissionErrors.push(r2Probe);
    components.push({ key: 'r2', label: r2Probe.label, status: 'permission_denied', expected: MANIFEST.r2, repairable: false, details: r2Probe.error });
  } else {
    const bucket = rows(r2Probe.value, 'buckets').find(item => item.name === MANIFEST.r2);
    components.push({ key: 'r2', label: 'R2 özel dosya alanı', status: bucket ? 'ready' : 'missing', current: bucket?.name, expected: MANIFEST.r2, repairable: !bucket });
  }

  if (!queuesProbe.ok) {
    permissionErrors.push(queuesProbe);
    for (const name of MANIFEST.queues) components.push({ key: `queue:${name}`, label: `Queue: ${name}`, status: 'permission_denied', expected: name, repairable: false, details: queuesProbe.error });
  } else {
    const queues = rows(queuesProbe.value, 'queues').map(item => ({ id: item.queue_id ?? item.id, name: item.queue_name ?? item.name }));
    for (const name of MANIFEST.queues) {
      const queue = queues.find(item => item.name === name);
      components.push({ key: `queue:${name}`, label: `Queue: ${name}`, status: queue ? 'ready' : 'missing', current: queue?.id, expected: name, repairable: !queue });
    }
  }

  if (!scriptsProbe.ok) {
    permissionErrors.push(scriptsProbe);
    components.push({ key: 'worker', label: scriptsProbe.label, status: 'permission_denied', expected: MANIFEST.worker, repairable: false, details: scriptsProbe.error });
  } else {
    const worker = rows(scriptsProbe.value, 'scripts').find(item => (item.id ?? item.name) === MANIFEST.worker);
    components.push({ key: 'worker', label: 'Worker uygulaması', status: worker ? 'ready' : 'missing', current: worker?.id ?? worker?.name, expected: MANIFEST.worker, repairable: true });
  }

  if (!vectorProbe.ok) {
    permissionErrors.push(vectorProbe);
    components.push({ key: 'vectorize', label: vectorProbe.label, status: 'permission_denied', expected: MANIFEST.vectorize, repairable: false, details: vectorProbe.error });
  } else {
    const vector = rows(vectorProbe.value, 'indexes').find(item => item.name === MANIFEST.vectorize);
    const vectorReady = Boolean(vector && vector.config?.dimensions === MANIFEST.vectorDimensions && (vector.config?.metric ?? MANIFEST.vectorMetric) === MANIFEST.vectorMetric);
    components.push({
      key: 'vectorize', label: 'Vectorize bilgi indeksi',
      status: !vector ? 'missing' : vectorReady ? 'ready' : 'misconfigured',
      current: vector ? `${vector.name} / ${vector.config?.dimensions ?? '?'} / ${vector.config?.metric ?? '?'}` : undefined,
      expected: `${MANIFEST.vectorize} / ${MANIFEST.vectorDimensions} / ${MANIFEST.vectorMetric}`,
      repairable: !vector,
      details: vector && !vectorReady ? 'Yanlış boyutlu Vectorize indeksi silinmez veya üzerine yazılmaz.' : undefined
    });
  }

  const blocked = components.some(item => ['misconfigured', 'permission_denied'].includes(item.status));
  return {
    accountId: MANIFEST.accountId,
    checkedAt: new Date().toISOString(),
    overall: components.every(item => item.status === 'ready') ? 'ready' : blocked ? 'blocked' : 'repair_required',
    components,
    permissionErrors: permissionErrors.map(item => ({ label: item.label, permission: item.permission, error: item.error })),
    plan: components.filter(item => item.status !== 'ready').map(item => ({
      action: item.repairable ? (item.key === 'worker' ? 'deploy' : 'create') : 'review',
      resource: item.key,
      destructive: false,
      paid: false
    }))
  };
}

function assertFullSetupPermissions(report) {
  if (!report.permissionErrors?.length) return;
  const permissions = [...new Set(report.permissionErrors.map(item => item.permission))].join(', ');
  const details = report.permissionErrors.map(item => `${item.label}: ${item.error}`).join(' | ');
  throw new Error(`Cloudflare API tokeninin tam kurulum izinleri eksik. Gerekli izinler: ${permissions}. ${details}`);
}

async function createMissingResources(token, report, selectedActions) {
  const selected = selectedActions?.length ? new Set(selectedActions) : null;
  const applied = [];
  const skipped = [];
  for (const item of report.components) {
    if (item.status !== 'missing' || !item.repairable || item.key === 'worker') continue;
    if (selected && !selected.has(item.key)) continue;
    if (item.key === 'r2') {
      await cf(token, `/accounts/${MANIFEST.accountId}/r2/buckets`, { method: 'POST', body: JSON.stringify({ name: MANIFEST.r2 }) }, 'R2 oluşturma');
      applied.push(item.key);
      continue;
    }
    if (item.key.startsWith('queue:')) {
      const queueName = item.key.slice('queue:'.length);
      if (!MANIFEST.queues.includes(queueName)) { skipped.push(item.key); continue; }
      await cf(token, `/accounts/${MANIFEST.accountId}/queues`, { method: 'POST', body: JSON.stringify({ queue_name: queueName }) }, `${queueName} Queue oluşturma`);
      applied.push(item.key);
      continue;
    }
    if (item.key === 'vectorize') {
      await cf(token, `/accounts/${MANIFEST.accountId}/vectorize/v2/indexes`, {
        method: 'POST',
        body: JSON.stringify({ name: MANIFEST.vectorize, config: { dimensions: MANIFEST.vectorDimensions, metric: MANIFEST.vectorMetric } })
      }, 'Vectorize oluşturma');
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
  if (result.error) throw new Error(`${options.label ?? path.basename(command)} başlatılamadı: ${safeError(result.error)}`);
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

async function waitForWorker() {
  let lastError = 'Worker henüz hazır değil.';
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try { return await readWorkerHealth(); }
    catch (error) { lastError = safeError(error); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error(`Cloudflare Worker sağlık kontrolü geçmedi: ${lastError}`);
}

function encodedPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256');
  return `pbkdf2-sha256$310000$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function activeOwnerCount(token) {
  let entries;
  try {
    entries = await d1Query(token, "SELECT COUNT(*) AS total FROM admins WHERE role='owner' AND status='active' AND deleted_at IS NULL");
  } catch (error) {
    throw new Error(`Yönetici tablosu okunamadı. Production migrationları eksik olabilir veya tokenin D1 Read izni yoktur. ${safeError(error)}`);
  }
  return Number(entries[0]?.results?.[0]?.total ?? 0);
}

async function createFirstOwner(input, token) {
  const now = new Date().toISOString();
  const email = input.adminEmail.trim().toLowerCase();
  const id = crypto.randomUUID();
  try {
    await d1Query(token, `
INSERT INTO admins
  (id,name,email,password_hash,role,status,failed_login_count,locked_until,last_login_at,created_at,updated_at,deleted_at)
VALUES
  (?,?,?,?, 'owner','active',0,NULL,NULL,?,?,NULL)
ON CONFLICT(email) DO UPDATE SET
  name=excluded.name,
  password_hash=excluded.password_hash,
  role='owner',
  status='active',
  failed_login_count=0,
  locked_until=NULL,
  updated_at=excluded.updated_at,
  deleted_at=NULL
`, [id, input.adminName.trim(), email, encodedPasswordHash(input.adminPassword), now, now]);
  } catch (error) {
    throw new Error(`İlk yönetici hesabı oluşturulamadı. Token izinlerinde D1 Write bulunmalıdır. ${safeError(error)}`);
  }
  return { id, name: input.adminName.trim(), email, role: 'owner' };
}

async function verifyDesktopLogin(input) {
  const deviceId = `wpai-bootstrap-${crypto.randomBytes(24).toString('hex')}`;
  const session = await workerRequest('/api/auth/desktop/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tauri.localhost' },
    body: JSON.stringify({
      email: input.adminEmail.trim().toLowerCase(),
      password: input.adminPassword,
      deviceId,
      deviceName: 'WPAI Windows Bağlantı Doğrulaması',
      appVersion: '1.3.2'
    })
  });
  if (!session?.accessToken || !session?.refreshToken || session.admin?.email !== input.adminEmail.trim().toLowerCase()) {
    throw new Error('Windows yönetici giriş doğrulaması geçersiz cevap döndürdü.');
  }
  await workerRequest('/api/auth/desktop/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://tauri.localhost' },
    body: JSON.stringify({ refreshToken: session.refreshToken, deviceId })
  });
  return session.admin;
}

async function ensureOwnerAndLogin(input, token) {
  const count = await activeOwnerCount(token);
  let created = false;
  if (count === 0) {
    await createFirstOwner(input, token);
    created = true;
  }
  try {
    const admin = await verifyDesktopLogin(input);
    return { ...admin, created };
  } catch (error) {
    if (created) throw new Error(`Yönetici hesabı oluşturuldu ancak Windows girişi doğrulanamadı. ${safeError(error)}`);
    throw new Error(`Bu WPAI Cloudflare projesinde daha önce oluşturulmuş bir yönetici hesabı var. Bağlantı ekranı mevcut yöneticilerin parolasını veya hesabını sessizce değiştirmez. Mevcut yönetici e-postası ve parolasıyla giriş yapın. ${safeError(error)}`);
  }
}

async function connectionCheck(token) {
  const verified = await verifyToken(token);
  const database = await verifyProductionD1(token);
  const worker = await tryWorkerHealth();
  return {
    accountId: MANIFEST.accountId,
    checkedAt: new Date().toISOString(),
    tokenStatus: verified.status,
    database: { name: database.name, id: database.uuid, ready: true },
    worker: { url: WORKER_URL, ready: worker.ready, error: worker.error }
  };
}

async function setup(input) {
  const preflight = await connectionCheck(input.apiToken);
  if (preflight.worker.ready) {
    const admin = await ensureOwnerAndLogin(input, input.apiToken);
    return { ok: true, action: 'setup', mode: 'connect_existing', workerUrl: WORKER_URL, checkedAt: new Date().toISOString(), admin, report: preflight };
  }

  const before = await fullScan(input.apiToken);
  assertFullSetupPermissions(before);
  if (before.components.some(item => item.status === 'misconfigured')) {
    throw new Error('Cloudflare hesabında otomatik değiştirilemeyecek yanlış yapılandırma bulundu. Mevcut D1 veya Vectorize kaynağı veri güvenliği için değiştirilmedi.');
  }
  const changes = await createMissingResources(input.apiToken, before, input.actions);
  const afterResources = await fullScan(input.apiToken);
  assertFullSetupPermissions(afterResources);
  const requiredAfterRepair = afterResources.components.filter(item => item.key !== 'worker' && item.status !== 'ready');
  if (requiredAfterRepair.length) throw new Error(`Cloudflare kaynak kurulumu tamamlanamadı: ${requiredAfterRepair.map(item => item.label).join(', ')}`);

  const workerAlreadyExists = afterResources.components.find(item => item.key === 'worker')?.status === 'ready';
  const generatedSecrets = workerAlreadyExists ? {} : {
    SESSION_SIGNING_KEY: crypto.randomBytes(48).toString('base64url'),
    DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    ADMIN_BOOTSTRAP_TOKEN: crypto.randomBytes(48).toString('base64url')
  };
  installAndDeploy(input.apiToken, generatedSecrets);
  await waitForWorker();
  const admin = await ensureOwnerAndLogin(input, input.apiToken);
  return {
    ok: true,
    action: 'setup',
    mode: workerAlreadyExists ? 'repair_existing_worker' : 'install_new_worker',
    checkedAt: new Date().toISOString(),
    accountId: MANIFEST.accountId,
    workerUrl: WORKER_URL,
    applied: changes.applied,
    admin,
    report: await connectionCheck(input.apiToken)
  };
}

async function main() {
  const input = await readInput();
  validateInput(input);
  const secretsToRedact = [input.apiToken, input.adminPassword];
  try {
    if (input.action === 'scan') {
      output({ ok: true, action: 'scan', report: await connectionCheck(input.apiToken) });
      return;
    }
    if (input.action === 'repair') {
      const before = await fullScan(input.apiToken);
      assertFullSetupPermissions(before);
      const changes = await createMissingResources(input.apiToken, before, input.actions);
      output({ ok: true, action: 'repair', applied: changes.applied, skipped: changes.skipped, report: await fullScan(input.apiToken) });
      return;
    }
    output(await setup(input));
  } catch (error) {
    output({ ok: false, error: safeError(error, secretsToRedact) });
    process.exitCode = 1;
  }
}

main().catch(error => {
  output({ ok: false, error: safeError(error) });
  process.exitCode = 1;
});
