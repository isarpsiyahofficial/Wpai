import type { ApiResponse } from '../shared/contracts';
import type { Admin } from './types';
import { desktop } from './desktop';

const DESKTOP_API_BASE = 'https://wa-ai-panel.wa-ai-panel.workers.dev';
let csrfToken = '';
let desktopAccessToken = '';
let desktopAccessExpiresAt = 0;
let refreshPromise: Promise<DesktopSession> | null = null;

export type DesktopSession = {
  admin: Admin;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

export function setCsrfToken(value: string): void { csrfToken = value; }
export function getCsrfToken(): string { return csrfToken; }
export function isDesktop(): boolean { return desktop.available(); }

function apiUrl(path: string): string {
  if (!desktop.available()) return path;
  if (!path.startsWith('/')) throw new Error('Masaüstü API yolu geçersiz.');
  return `${DESKTOP_API_BASE}${path}`;
}

function applyDesktopSession(session: DesktopSession): void {
  if (!session.accessToken || !session.accessExpiresAt) throw new Error('Masaüstü oturum cevabı geçersiz.');
  desktopAccessToken = session.accessToken;
  desktopAccessExpiresAt = Date.parse(session.accessExpiresAt);
  if (!Number.isFinite(desktopAccessExpiresAt)) throw new Error('Masaüstü oturum süresi geçersiz.');
}

function clearDesktopMemory(): void {
  desktopAccessToken = '';
  desktopAccessExpiresAt = 0;
}

async function parseJson<T>(response: Response): Promise<T> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    if (!response.ok) throw new Error(`İstek başarısız (${response.status}).`);
    return await response.blob() as T;
  }
  const body = await response.json() as ApiResponse<T>;
  if (!response.ok || !body.ok) throw new Error(body.ok ? `İstek başarısız (${response.status}).` : body.error.message);
  return body.data;
}

async function publicDesktopRequest<T>(path: string, payload?: unknown): Promise<T> {
  const init: RequestInit = {
    method: payload === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    cache: 'no-store'
  };
  if (payload !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(payload);
  }
  return parseJson<T>(await fetch(apiUrl(path), init));
}

export async function desktopLogin(email: string, password: string): Promise<DesktopSession> {
  if (!navigator.onLine) throw new Error('Çevrimdışıyken bulut hesabına giriş yapılamaz.');
  if (!desktop.available()) throw new Error('Masaüstü oturumu yalnız Windows uygulamasında kullanılabilir.');
  const deviceId = await desktop.getOrCreateDeviceId();
  const session = await publicDesktopRequest<DesktopSession>('/api/auth/desktop/login', {
    email,
    password,
    deviceId,
    deviceName: navigator.userAgent.includes('Windows') ? 'WPAI Windows' : 'WPAI Desktop',
    appVersion: '1.3.4'
  });
  await desktop.saveRefreshToken(session.refreshToken);
  applyDesktopSession(session);
  return session;
}

export async function restoreDesktopSession(): Promise<DesktopSession> {
  if (!desktop.available()) throw new Error('Masaüstü oturumu kullanılamıyor.');
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const refreshToken = await desktop.loadRefreshToken();
    if (!refreshToken) throw new Error('Kayıtlı masaüstü oturumu yok.');
    const deviceId = await desktop.getOrCreateDeviceId();
    try {
      const session = await publicDesktopRequest<DesktopSession>('/api/auth/desktop/refresh', { refreshToken, deviceId });
      await desktop.saveRefreshToken(session.refreshToken);
      applyDesktopSession(session);
      return session;
    } catch (error) {
      clearDesktopMemory();
      await desktop.removeRefreshToken().catch(() => undefined);
      throw error;
    }
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function desktopLogout(): Promise<void> {
  if (!desktop.available()) return;
  const [refreshToken, deviceId] = await Promise.all([
    desktop.loadRefreshToken().catch(() => null),
    desktop.getOrCreateDeviceId()
  ]);
  if (refreshToken) {
    await publicDesktopRequest('/api/auth/desktop/logout', { refreshToken, deviceId }).catch(() => undefined);
  }
  clearDesktopMemory();
  await desktop.removeRefreshToken().catch(() => undefined);
}

function isStateChanging(method: string | undefined): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes((method ?? 'GET').toUpperCase());
}

function ensureDesktopOnline(path: string, init: RequestInit): void {
  if (!navigator.onLine && isStateChanging(init.method)) {
    throw new Error(`Çevrimdışıyken veri değiştirilemez veya mesaj gönderilemez (${path}).`);
  }
}

async function desktopFetch(path: string, init: RequestInit, retry = true): Promise<Response> {
  ensureDesktopOnline(path, init);
  if (!navigator.onLine) throw new Error('İnternet bağlantısı yok. Bulut işlemleri geçici olarak kullanılamıyor.');
  if (!desktopAccessToken || desktopAccessExpiresAt <= Date.now() + 30_000) await restoreDesktopSession();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${desktopAccessToken}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: 'omit',
    cache: init.cache ?? 'no-store'
  });
  if (response.status === 401 && retry) {
    clearDesktopMemory();
    await restoreDesktopSession();
    return desktopFetch(path, init, false);
  }
  return response;
}

async function webFetch(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes((init.method ?? 'GET').toUpperCase())) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  return fetch(path, { ...init, headers, credentials: 'include' });
}

async function unauthenticatedFetch(path: string, init: RequestInit): Promise<Response> {
  if (desktop.available()) {
    return fetch(apiUrl(path), { ...init, credentials: 'omit', cache: init.cache ?? 'no-store' });
  }
  return webFetch(path, init);
}

export async function publicApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  return parseJson<T>(await unauthenticatedFetch(path, init));
}

export async function publicRawJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await unauthenticatedFetch(path, init);
  if (!response.ok) throw new Error(`İstek başarısız (${response.status}).`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new Error('Beklenen JSON cevabı alınamadı.');
  return response.json() as Promise<T>;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = desktop.available() ? await desktopFetch(path, init) : await webFetch(path, init);
  const data = await parseJson<T>(response);
  if (
    desktop.available()
    && path === '/api/training/memory/clear'
    && (init.method ?? 'GET').toUpperCase() === 'POST'
  ) {
    await desktop.faissClear();
    const status = await desktop.faissStatus() as { count?: number };
    if (status.count !== 0) {
      throw new Error('Bulut AI hafızası kapatıldı ancak bu cihazdaki yerel FAISS temizlenemedi. Yerel indeksi yeniden temizleyin.');
    }
  }
  return data;
}

export async function apiBlob(path: string): Promise<Blob> {
  const response = desktop.available()
    ? await desktopFetch(path, { method: 'GET' })
    : await webFetch(path, { method: 'GET' });
  if (!response.ok) {
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('application/json')) await parseJson(response);
    throw new Error(`Dosya isteği başarısız (${response.status}).`);
  }
  return response.blob();
}

export async function downloadApiFile(path: string, fileName: string): Promise<void> {
  const blob = await apiBlob(path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function apiObjectUrl(path: string): Promise<string> {
  return URL.createObjectURL(await apiBlob(path));
}

export function jsonBody(value: unknown): Pick<RequestInit, 'body'> { return { body: JSON.stringify(value) }; }
export function formValue(form: HTMLFormElement, name: string): string { return String(new FormData(form).get(name) ?? '').trim(); }
