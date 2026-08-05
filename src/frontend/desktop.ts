import { invoke } from '@tauri-apps/api/core';

export type DesktopPreferences = {
  closeToTray: boolean;
  autostartEnabled: boolean;
  notificationsEnabled: boolean;
  notificationRedact: boolean;
};

export type LocalIndexVector = {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
};

export type FaissMatch = {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
};

function available(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function invokeError(error: unknown, command: string): Error {
  if (error instanceof Error && error.message.trim()) return error;
  if (typeof error === 'string' && error.trim()) return new Error(error.trim());
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; error?: unknown; details?: unknown };
    for (const value of [candidate.message, candidate.error, candidate.details]) {
      if (typeof value === 'string' && value.trim()) return new Error(value.trim());
    }
    try {
      const encoded = JSON.stringify(error);
      if (encoded && encoded !== '{}') return new Error(encoded);
    } catch { /* use the safe fallback below */ }
  }
  return new Error(`Windows bağlantı işlemi ayrıntı döndürmeden başarısız oldu (${command}).`);
}

async function requiredInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!available()) throw new Error('Bu işlem yalnız WPAI Windows uygulamasında kullanılabilir.');
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw invokeError(error, command);
  }
}

export const desktop = {
  available,
  async getOrCreateDeviceId(): Promise<string> {
    const seed = `wpai-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    return requiredInvoke<string>('get_or_create_device_id', { seed });
  },
  saveRefreshToken(token: string): Promise<void> {
    return requiredInvoke<void>('save_desktop_refresh_token', { token });
  },
  loadRefreshToken(): Promise<string | null> {
    return requiredInvoke<string | null>('load_desktop_refresh_token');
  },
  removeRefreshToken(): Promise<void> {
    return requiredInvoke<void>('remove_desktop_refresh_token');
  },
  preferences(): Promise<DesktopPreferences> {
    return requiredInvoke<DesktopPreferences>('desktop_preferences');
  },
  setPreferences(preferences: DesktopPreferences): Promise<DesktopPreferences> {
    return requiredInvoke<DesktopPreferences>('set_desktop_preferences', { preferences });
  },
  setAutostart(enabled: boolean): Promise<DesktopPreferences> {
    return requiredInvoke<DesktopPreferences>('set_windows_autostart', { enabled });
  },
  pickFile(): Promise<{ name: string; mimeType: string; bytes: number[] } | null> {
    return requiredInvoke<{ name: string; mimeType: string; bytes: number[] } | null>('pick_desktop_file');
  },
  notify(title: string, body: string): Promise<void> {
    return requiredInvoke<void>('show_desktop_notification', { title, body });
  },
  showMainWindow(): Promise<void> {
    return requiredInvoke<void>('show_main_window');
  },
  quit(): Promise<void> {
    return requiredInvoke<void>('quit_application');
  },
  cloudflareConnectionStatus(): Promise<{ configured: boolean; accountId: string; storage: string }> {
    return requiredInvoke('cloudflare_connection_status');
  },
  cloudflareScan(accountId: string, apiToken?: string): Promise<Record<string, unknown>> {
    return requiredInvoke('cloudflare_scan', { accountId, apiToken: apiToken || null });
  },
  cloudflareRepair(accountId: string, actions: string[], apiToken?: string): Promise<Record<string, unknown>> {
    return requiredInvoke('cloudflare_repair', { accountId, actions, apiToken: apiToken || null });
  },
  cloudflareSetup(input: { accountId: string; apiToken: string; adminName: string; adminEmail: string; adminPassword: string }): Promise<Record<string, unknown>> {
    return requiredInvoke('cloudflare_setup', input);
  },
  cloudflareForget(): Promise<{ forgotten: boolean; accountId: string }> {
    return requiredInvoke('cloudflare_forget');
  },
  faissHealth(): Promise<Record<string, unknown>> {
    return requiredInvoke<Record<string, unknown>>('faiss_health');
  },
  faissStatus(): Promise<Record<string, unknown>> {
    return requiredInvoke<Record<string, unknown>>('faiss_status');
  },
  faissReplace(sourceChecksum: string, vectors: LocalIndexVector[]): Promise<Record<string, unknown>> {
    return requiredInvoke<Record<string, unknown>>('faiss_replace', { sourceChecksum, vectors });
  },
  faissUpsert(id: string, vector: number[], metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
    return requiredInvoke<Record<string, unknown>>('faiss_upsert', { id, vector, metadata });
  },
  faissDelete(ids: string[]): Promise<Record<string, unknown>> {
    return requiredInvoke<Record<string, unknown>>('faiss_delete', { ids });
  },
  faissSearch(vector: number[], topK = 6, threshold = 0.62): Promise<FaissMatch[]> {
    return requiredInvoke<FaissMatch[]>('faiss_search', { vector, topK, threshold });
  },
  faissSearchText(query: string, topK = 8, threshold = 0.12): Promise<FaissMatch[]> {
    return requiredInvoke<FaissMatch[]>('faiss_search_text', { query, topK, threshold });
  },
  faissClear(): Promise<Record<string, unknown>> {
    return requiredInvoke<Record<string, unknown>>('faiss_clear');
  }
};
