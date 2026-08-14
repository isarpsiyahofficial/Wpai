import process from 'node:process';

const port = Number(process.argv[2] || 9222);
const deadline = Date.now() + 45_000;

async function sleep(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }

async function findTarget() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch { /* WebView2 may still be starting. */ }
    await sleep(500);
  }
  throw new Error(`Installed WPAI WebView2 DevTools target was not available on port ${port}.`);
}

async function evaluate(webSocketDebuggerUrl, expression) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket open timed out.')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket failed.')); }, { once: true });
  });
  const id = Math.floor(Math.random() * 1_000_000) + 1;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP Runtime.evaluate timed out.')), 5_000);
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      resolve(message);
    });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  socket.close();
  if (result.error) throw new Error(`CDP evaluation error: ${JSON.stringify(result.error)}`);
  if (result.result?.exceptionDetails) throw new Error(`Page evaluation threw: ${JSON.stringify(result.result.exceptionDetails)}`);
  return result.result?.result?.value;
}

function requireText(text, value, label) {
  if (!String(value).includes(text)) throw new Error(`${label}: expected text missing: ${text}`);
}

function forbidText(text, value, label) {
  if (String(value).includes(text)) throw new Error(`${label}: forbidden credential text is visible: ${text}`);
}

const target = await findTarget();
let body = '';
while (Date.now() < deadline) {
  body = String(await evaluate(target.webSocketDebuggerUrl, 'document.body?.innerText || ""'));
  if (body.includes('Gösterge Paneli') && body.includes('WhatsApp') && body.includes('Ayarlar')) break;
  await sleep(500);
}
requireText('Gösterge Paneli', body, 'main shell');
requireText('WhatsApp', body, 'main shell');
requireText('AI Kontrolü', body, 'main shell');
requireText('Ayarlar', body, 'main shell');
forbidText('Cloudflare User veya Account API Token', body, 'main shell');
forbidText('Panele Giriş Yap', body, 'main shell');

await evaluate(target.webSocketDebuggerUrl, `(() => {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Ayarlar');
  if (!button) throw new Error('Ayarlar button missing');
  button.click();
  return true;
})()`);
await sleep(1_000);
const settings = String(await evaluate(target.webSocketDebuggerUrl, `JSON.stringify({
  text: document.body?.innerText || '',
  apiTokenInputs: document.querySelectorAll('input[name="apiToken"]').length,
  passwordInputs: document.querySelectorAll('input[type="password"]').length
})`));
const parsed = JSON.parse(settings);
requireText('WPAI Cihaz Bağlantısı', parsed.text, 'settings');
requireText('WhatsApp / Meta Bağlantısı', parsed.text, 'settings');
forbidText('Cloudflare User veya Account API Token', parsed.text, 'settings');
forbidText('Yeni Cloudflare API Token', parsed.text, 'settings');
if (parsed.apiTokenInputs !== 0) throw new Error(`settings: Cloudflare API token input count=${parsed.apiTokenInputs}`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  targetTitle: target.title,
  targetUrl: target.url,
  mainShellVerified: true,
  settingsVerified: true,
  cloudflareCredentialInputs: 0,
  note: 'Meta integration may legitimately contain provider credential fields in Settings.'
}, null, 2)}\n`);
