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

async function requiredInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!available()) throw new Error('Bu işlem yalnız WPAI Windows uygulamasında kullanılabilir.');
  return invoke<T>(command, args);
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
  showMainWindow(): Promise<void> {
    return requiredInvoke<void>('show_main_window');
  },
  quit(): Promise<void> {
    return requiredInvoke<void>('quit_application');
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
  faissClear(): Promise<Record<string, unknown>> {
    return requiredInvoke<Record<string, unknown>>('faiss_clear');
  }
};
