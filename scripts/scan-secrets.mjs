import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignoredDirectories = new Set(['.git','node_modules','dist','.wrangler','target','coverage','.pytest_cache','__pycache__']);
const ignoredFiles = new Set(['package-lock.json','Cargo.lock']);
const textExtensions = new Set(['.ts','.tsx','.js','.mjs','.cjs','.json','.jsonc','.toml','.yml','.yaml','.md','.txt','.sql','.py','.rs','.html','.css','.env','.example']);
const patterns = [
  { name: 'Cloudflare API token', regex: /\bcfat_[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Cloudflare legacy global key', regex: /\b[a-f0-9]{37}\b/gi },
  { name: 'Bearer credential', regex: /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}=*\b/g },
  { name: 'PEM private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'Meta permanent access token', regex: /\bEA[A-Za-z0-9]{80,}\b/g },
  { name: 'GitHub token', regex: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{30,}\b/g },
  { name: 'AWS access key', regex: /\bAKIA[A-Z0-9]{16}\b/g }
];

const findings = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (ignoredFiles.has(entry.name)) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!textExtensions.has(extension) && !entry.name.startsWith('.env')) continue;
    const relative = path.relative(root, full).replaceAll('\\','/');
    const content = fs.readFileSync(full, 'utf8');
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      for (const match of content.matchAll(pattern.regex)) {
        const line = content.slice(0, match.index).split('\n').length;
        findings.push(`${relative}:${line} ${pattern.name}`);
      }
    }
  }
}
walk(root);
if (findings.length) {
  console.error('Kaynak dosyalarda olası gizli bilgi bulundu:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log('Secret taraması temiz: kaynak ve yapılandırmada bilinen credential biçimi yok.');
