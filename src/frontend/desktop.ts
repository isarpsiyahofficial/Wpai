type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function hasTauri(): boolean { return '__TAURI_INTERNALS__' in window; }
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasTauri()) throw new Error('DESKTOP_ONLY');
  const module = await import('@tauri-apps/api/core');
  return module.invoke<T>(command, args);
}

export const desktop = {
  available: hasTauri,
  async saveCloudflareToken(token: string): Promise<void> { await invoke('save_cloudflare_token', { token }); },
  async loadCloudflareToken(): Promise<string | null> { return invoke<string | null>('load_cloudflare_token'); },
  async removeCloudflareToken(): Promise<void> { await invoke('remove_cloudflare_token'); },
  async faissUpsert(id: string, vector: number[], metadata: Record<string, unknown>): Promise<void> { await invoke('faiss_upsert', { id, vector, metadata }); },
  async faissSearch(vector: number[], topK = 6): Promise<Array<{ id: string; score: number; metadata: Record<string, unknown> }>> { return invoke('faiss_search', { vector, topK }); }
};
