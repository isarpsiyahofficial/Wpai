import type { ApiResponse } from '../shared/contracts';

let csrfToken = '';
export function setCsrfToken(value: string): void { csrfToken = value; }
export function getCsrfToken(): string { return csrfToken; }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (csrfToken && ['POST','PUT','PATCH','DELETE'].includes((init.method ?? 'GET').toUpperCase())) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    if (!response.ok) throw new Error(`İstek başarısız (${response.status}).`);
    return await response.blob() as T;
  }
  const body = await response.json() as ApiResponse<T>;
  if (!response.ok || !body.ok) throw new Error(body.ok ? `İstek başarısız (${response.status}).` : body.error.message);
  return body.data;
}

export function jsonBody(value: unknown): Pick<RequestInit, 'body'> { return { body: JSON.stringify(value) }; }
export function formValue(form: HTMLFormElement, name: string): string { return String(new FormData(form).get(name) ?? '').trim(); }
