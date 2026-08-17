import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, formValue } from '../api';
import { desktop, type FaissMatch, type LocalIndexVector } from '../desktop';
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
  textIndexVersion?: number | null;
  textSearchReady?: boolean;
};

type SearchMetadata = {
  title?: string;
  category?: string;
  content?: string;
  scope?: string;
  version?: number;
};

export function DesktopIndexPanel({ notify, offlineOnly = false }: { notify: Notify; offlineOnly?: boolean }) {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [matches, setMatches] = useState<FaissMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    if (!desktop.available()) return;
    try {
      await desktop.faissHealth();
      setStatus(await desktop.faissStatus() as LocalStatus);
    } catch (error) {
      setStatus(null);
      notify(error instanceof Error ? error.message : 'Yerel eğitim indeksi durumu okunamadı.', 'error');
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);
  if (!desktop.available()) return null;

  async function synchronize() {
    if (offlineOnly || !navigator.onLine) {
      notify('Çevrimdışıyken bulut senkronizasyonu yapılamaz. Yerel arama kullanılabilir.', 'info');
      return;
    }
    setBusy(true);
    try {
      const bundle = await api<Bundle>('/api/training/local-index-bundle');
      if (
        bundle.format !== 'wpai-local-index-bundle'
        || bundle.version !== 1
        || bundle.dimensions !== 1024
        || bundle.count !== bundle.vectors.length
        || bundle.sourceChecksum.length !== 64
      ) throw new Error('Bulut bilgi paketi doğrulanamadı.');
      const result = await desktop.faissReplace(bundle.sourceChecksum, bundle.vectors) as LocalStatus & { unchanged?: boolean };
      const checked = await desktop.faissStatus() as LocalStatus;
      if (
        checked.count !== bundle.count
        || checked.sourceChecksum !== bundle.sourceChecksum
        || checked.dimension !== (bundle.count ? 1024 : 0)
        || (bundle.count > 0 && checked.textSearchReady !== true)
      ) {
        throw new Error('Yerel eğitim indeksi senkronizasyon sonrası doğrulanamadı.');
      }
      setStatus(checked);
      notify(result.unchanged ? 'Yerel eğitim indeksi zaten güncel.' : `${bundle.count} onaylı bilgi parçası yerel indekse güvenli biçimde yazıldı.`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Yerel eğitim indeksi senkronize edilemedi.', 'error');
    } finally { setBusy(false); }
  }

  async function searchLocal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = formValue(event.currentTarget, 'query');
    if (query.length < 2) return;
    setSearching(true);
    try {
      const result = await desktop.faissSearchText(query, 8, 0.08);
      setMatches(result);
      if (!result.length) notify('Yerel onaylı bilgilerde eşleşme bulunamadı.', 'info');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Yerel bilgi araması yapılamadı.', 'error');
    } finally { setSearching(false); }
  }

  async function clearLocal() {
    if (!window.confirm('Yalnız bu Windows cihazındaki yerel eğitim indeksi silinsin mi? Bulut bilgi bankası etkilenmez.')) return;
    setBusy(true);
    try {
      await desktop.faissClear();
      setMatches([]);
      await load();
      notify('Bu cihazdaki yerel eğitim indeksi temizlendi.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Yerel eğitim indeksi temizlenemedi.', 'error');
    } finally { setBusy(false); }
  }

  return <section className="panel desktop-index-panel">
    <div className="panel-heading">
      <div>
        <h3>Yerel Eğitim İndeksi</h3>
        <p>{offlineOnly ? 'Çevrimdışı, yalnız-okunur mod. Yalnız daha önce senkronize edilmiş ve yönetici tarafından onaylanmış bilgiler aranır.' : 'Onaylı bulut bilgilerini bu Windows cihazına güvenli biçimde senkronize eder ve internet olmadan aramaya açar.'}</p>
      </div>
      <span className={`pill ${status?.ok && (status.count === 0 || status.textSearchReady) ? 'ready' : 'warn'}`}>
        {status?.ok && (status.count === 0 || status.textSearchReady) ? 'Yerel arama hazır' : 'Doğrulanmadı'}
      </span>
    </div>

    <form className="form-stack local-index-search" onSubmit={searchLocal}>
      <label>Onaylı yerel bilgilerde ara
        <input name="query" minLength={2} maxLength={5000} required placeholder="Örn. admin panelli kurumsal site hizmeti" />
      </label>
      <div className="form-actions"><button className="button primary" disabled={searching || !status?.textSearchReady}>{searching ? 'Aranıyor…' : 'Yerel Bilgide Ara'}</button></div>
    </form>

    {matches.length > 0 && <div className="local-search-results" aria-live="polite">
      {matches.map(match => {
        const metadata = match.metadata as SearchMetadata;
        return <article key={match.id} className="summary-box">
          <strong>{metadata.title || 'Onaylı bilgi'}</strong>
          <span className="pill">{metadata.category || 'Genel'}</span>
          <p>{metadata.content || 'İçerik önizlemesi yok.'}</p>
          <small>Benzerlik %{Math.round(match.score * 100)} · Kapsam {metadata.scope || 'global'} · Sürüm {metadata.version ?? '—'}</small>
        </article>;
      })}
    </div>}

    {status ? <div className="summary-grid">
      <div><span>Yerel bilgi parçası</span><strong>{status.count ?? 0}</strong></div>
      <div><span>Çevrimdışı arama</span><strong>{status.textSearchReady ? 'Hazır' : status.count ? 'Yeniden senkronizasyon gerekli' : 'İndeks boş'}</strong></div>
      <div><span>Son güncelleme</span><strong>{status.updatedAt ? new Date(status.updatedAt * 1000).toLocaleString('tr-TR') : 'Henüz yok'}</strong></div>
    </div> : <Empty text="Yerel eğitim indeksi durumu henüz doğrulanmadı." />}

    <div className="form-actions">
      <button className="button secondary" disabled={busy} onClick={() => void load()}>Durumu Doğrula</button>
      <button className="button secondary" disabled={busy} onClick={() => void clearLocal()}>Yerel İndeksi Temizle</button>
      {!offlineOnly && <button className="button primary" disabled={busy || !navigator.onLine} onClick={() => void synchronize()}>{busy ? 'Doğrulanıyor…' : 'Buluttan Tam Senkronize Et'}</button>}
    </div>

    <details className="advanced-status">
      <summary>Gelişmiş teknik durum</summary>
      <div className="summary-grid">
        <div><span>FAISS boyutu</span><strong>{status?.dimension ?? 0}</strong></div>
        <div><span>Metin indeks sürümü</span><strong>{status?.textIndexVersion ?? '—'}</strong></div>
        <div><span>Kaynak checksum</span><strong>{status?.sourceChecksum ? `${status.sourceChecksum.slice(0, 14)}…` : 'Boş'}</strong></div>
        <div><span>İçerik checksum</span><strong>{status?.contentChecksum ? `${status.contentChecksum.slice(0, 14)}…` : 'Boş'}</strong></div>
      </div>
    </details>
  </section>;
}
