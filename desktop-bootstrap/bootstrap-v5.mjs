import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const V6 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bootstrap-v6.mjs');
const raw = fs.readFileSync(0, 'utf8');
let input = null;
try { input = JSON.parse(raw || '{}'); } catch { input = null; }

let payload = raw;
if (input?.action === 'setup') {
  const deviceId = typeof input.deviceId === 'string' && input.deviceId.length >= 20
    ? input.deviceId
    : typeof input.adminName === 'string'
      ? input.adminName
      : '';
  const mapped = {
    action: 'setup',
    accountId: input.accountId,
    apiToken: input.apiToken,
    deviceId,
    deviceName: typeof input.deviceName === 'string' && input.deviceName.trim().length >= 2 ? input.deviceName : 'WPAI Windows',
    platform: typeof input.platform === 'string' && input.platform.trim().length >= 3 ? input.platform : 'windows',
    appVersion: typeof input.appVersion === 'string' ? input.appVersion : '1.3.6'
  };
  payload = JSON.stringify(mapped);
}

const result = spawnSync(process.execPath, [V6], {
  input: payload,
  encoding: 'utf8',
  env: process.env,
  windowsHide: true,
  timeout: 30 * 60_000,
  maxBuffer: 10 * 1024 * 1024
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'Cloudflare Device Bootstrap V6 başlatılamadı.' })}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
