import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { desktop, type LocalIndexVector } from '../desktop';
import type { Notify } from '../types';
import { Empty } from './core';

type Bundle = {
  format: 'wpai-local-index-bundle';
  version: 1;
  generatedAt: string;
  sourceChecksum: string;
  count: number;
  dimensions: number;
  embeddingModel: string;
  vectors: LocalIndexVector[];
};

type LocalStatus = {
  ok?: boolean;
  count?: number;
  dimension?: number;
  sourceChecksum?: string | null;
  contentChecksum?: string | null;
  updatedAt?: number | null;
};

export function DesktopIndexPanel({ notify }: { notify: Notify }) {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!desktop.available()) return;
    try {
      await desktop.faissHealth();
      setStatus(await desktop.faissStatus() as LocalStatus);
    } catch (error) {
      setStatus(null);
      notify(error instanceof Error ? error.message : 'Yerel FAISS durumu okunamadı.', 'error');
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);
  if (!desktop.available()) return null;

  async function synchronize() {
    setBusy(true);
    try {
      const bundle = await api<Bundle>('/api/training/local-index-bundle');
      if (
        bundle.format !== 'wpai-local-index-bundle'
        || bundle.version !== 1
        || bundle.dimensions !== 1024
        || bundle.count !== bundle.vectors.length
        || bundle.sourceChecksum.length !== 64
      ) throw new Error('Bulut yerel indeks paketi doğrulanamadı.');
      const result = await desktop.faissReplace(bundle.sourceChecksum, bundle.vectors) as LocalStatus & { unchanged?: boolean };
      const checked = await desktop.faissStatus() as LocalStatus;
      if (checked.count !== bundle.count || checked.sourceChecksum !== bundle.sourceChecksum || checked.dimension !== (bundle.count ? 1024 : 0)) {
        throw new Error('Yerel FAISS senkronizasyon sonrası doğrulaması başarısız.');
      }
      setStatus(checked);
      notify(result.unchanged ? 'Yerel FAISS zaten güncel.' : `${bundle.count} doğrulanmış vektör yerel FAISS’e atomik olarak yazıldı.`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Yerel FAISS senkronize edilemedi.', 'error');
    } finally { setBusy(false); }
  }

  async function clearLocal() {
    if (!window.confirm('Yalnız bu Windows cihazındaki yerel FAISS önbelleği silinsin mi? Bulut bilgi bankası etkilenmez.')) return;
    setBusy(true);
    try {
      await desktop.faissClear();
      await load();
      notify('Bu cihazdaki yerel FAISS önbelleği temizlendi.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Yerel FAISS temizlenemedi.', 'error');
    } finally { setBusy(false); }
  }

  return <section className="panel desktop-index-panel">
    <div className="panel-heading">
      <div><h3>Windows Yerel FAISS</h3><p>Buluttaki onaylı Vectorize artifact’larıyla aynı 1024 boyutlu vektörleri kullanır. Kısmi veya checksum uyuşmayan bundle kabul edilmez.</p></div>
      <span className={`pill ${status?.ok ? 'ready' : 'warn'}`}>{status?.ok ? 'Yerel servis hazır' : 'Doğrulanmadı'}</span>
    </div>
    {status ? <div className="summary-grid">
      <div><span>Yerel vektör</span><strong>{status.count ?? 0}</strong></div>
      <div><span>Boyut</span><strong>{status.dimension ?? 0}</strong></div>
      <div><span>Kaynak checksum</span><strong>{status.sourceChecksum ? `${status.sourceChecksum.slice(0, 14)}…` : 'Boş'}</strong></div>
      <div><span>İçerik checksum</span><strong>{status.contentChecksum ? `${status.contentChecksum.slice(0, 14)}…` : 'Boş'}</strong></div>
    </div> : <Empty text="Yerel FAISS durumu henüz doğrulanmadı." />}
    <div className="form-actions">
      <button className="button secondary" disabled={busy} onClick={() => void load()}>Durumu Doğrula</button>
      <button className="button secondary" disabled={busy} onClick={() => void clearLocal()}>Yalnız Yerel İndeksi Temizle</button>
      <button className="button primary" disabled={busy} onClick={() => void synchronize()}>{busy ? 'Doğrulanıyor…' : 'Buluttan Tam Senkronize Et'}</button>
    </div>
  </section>;
}
