const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PASSWORD_ITERATIONS = 310_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToBase64(data).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(encoder.encode(value)));
  return bytesToBase64(new Uint8Array(digest));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(encoder.encode(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationText, saltText, hashText] = encoded.split('$');
  if (algorithm !== 'pbkdf2-sha256' || !iterationText || !saltText || !hashText) return false;
  const iterations = Number(iterationText);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) return false;
  const salt = base64ToBytes(saltText);
  const expected = base64ToBytes(hashText);
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(encoder.encode(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' }, key, expected.byteLength * 8
  ));
  if (bits.byteLength !== expected.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < bits.byteLength; i += 1) diff |= bits[i]! ^ expected[i]!;
  return diff === 0;
}

async function importEncryptionKey(secret: string): Promise<CryptoKey> {
  let keyBytes: Uint8Array;
  try { keyBytes = base64ToBytes(secret); } catch { keyBytes = encoder.encode(secret); }
  if (keyBytes.byteLength !== 32) {
    keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(keyBytes)));
  }
  return crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string, secret: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await importEncryptionKey(secret);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encoder.encode(plaintext))
  ));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(ciphertext)}`;
}

export async function decryptSecret(encoded: string, secret: string): Promise<string> {
  const [version, ivText, cipherText] = encoded.split('.');
  if (version !== 'v1' || !ivText || !cipherText) throw new Error('INVALID_ENCRYPTED_SECRET');
  const key = await importEncryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(base64ToBytes(ivText)) },
    key,
    toArrayBuffer(base64ToBytes(cipherText))
  );
  return decoder.decode(plaintext);
}

export function passwordPolicy(password: string): string[] {
  const errors: string[] = [];
  if (password.length < 12) errors.push('Parola en az 12 karakter olmalıdır.');
  if (!/[a-zçğıöşü]/u.test(password)) errors.push('En az bir küçük harf gereklidir.');
  if (!/[A-ZÇĞİÖŞÜ]/u.test(password)) errors.push('En az bir büyük harf gereklidir.');
  if (!/\d/.test(password)) errors.push('En az bir rakam gereklidir.');
  return errors;
}
