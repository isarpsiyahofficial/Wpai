import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, formValue, jsonBody } from '../api';
import type { Notify, PageId } from '../types';

type AiUsage = {
  usedNeurons: number;
  entitlementNeurons: number;
  freeAllocationNeurons: number;
  remainingNeurons: number;
  overageNeurons: number;
  usagePercent: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  resetAt: string;
};

type DashboardData = {
  contacts: number;
  activeConversations: number;
  unreadMessages: number;
  openHandoffs: number;
  failedMessages: number;
  unreadNotifications: number;
};

export function DashboardPage({ notify, openPage }: { notify: Notify; openPage: (page: PageId) => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [usage, setUsage] = useState<AiUsage | null>(null);
  useEffect(() => {
    void Promise.all([api<DashboardData>('/api/dashboard'), api<AiUsage>('/api/ai/usage')])
      .then(([dashboard, neuron]) => { setData(dashboard); setUsage(neuron); })
      .catch((error: Error) => notify(error.message, 'error'));
  }, [notify]);
  const cards: Array<[string, string | number | undefined]> = [
    ['Toplam kişi', data?.contacts], ['Aktif konuşma', data?.activeConversations], ['Okunmamış mesaj', data?.unreadMessages],
    ['İnsan devri', data?.openHandoffs], ['Başarısız mesaj', data?.failedMessages], ['Bildirim', data?.unreadNotifications],
    ['Kullanılan Neuron', usage?.usedNeurons], ['Mevcut Neuron hakkı', usage?.entitlementNeurons],
    ['Kalan Neuron', usage?.remainingNeurons], ['Kullanım yüzdesi', usage ? `%${formatNumber(usage.usagePercent)}` : undefined]
  ];
  return <div className="page-stack"><section className="hero"><div><span className="eyebrow">Canlı işletme görünümü</span><h2>Mesajları, müşterileri ve AI kararlarını tek yerden yönetin.</h2><p>Bilgisayar kapalı olsa da Cloudflare mesajları almaya ve güvenli şekilde saklamaya devam eder.</p></div><div className="hero-actions"><button className="button primary" onClick={() => openPage('whatsapp')}>WhatsApp Gelen Kutusu</button><button className="button secondary" onClick={() => openPage('settings')}>Bağlantıları Kontrol Et</button></div></section><section className="metrics">{cards.map(([label,value]) => <article className="metric" key={label}><span>{label}</span><strong>{value === undefined ? '—' : typeof value === 'number' ? formatNumber(value) : value}</strong></article>)}</section><section className="panel"><h3>Güvenli başlangıç</h3><div className="check-list"><span>✓ AI varsayılan olarak kapalıdır.</span><span>✓ Müşteri bağlamları contact_id + conversation_id ile ayrılır.</span><span>✓ Fiyat ve işletme bilgisi yalnız onaylı kayıtlardan alınır.</span><span>✓ Manuel yönetici mesajı AI’ı insan devri moduna alır.</span></div></section></div>;
}

type Contact = { id: string; phone_e164: string; display_name: string; company_name: string | null; email: string | null; city: string | null; status: string; source: string; created_at: string };
export function ContactsPage({ notify }: { notify: Notify }) {
  const [items, setItems] = useState<Contact[]>([]); const [query, setQuery] = useState(''); const [importResult, setImportResult] = useState<Record<string, unknown> | null>(null);
  const load = useCallback(() => void api<Contact[]>(`/api/contacts?q=${encodeURIComponent(query)}`).then(setItems).catch(error => notify(error.message,'error')), [query, notify]);
  useEffect(() => { load(); }, [load]);
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form=event.currentTarget; try { await api('/api/contacts',{method:'POST',...jsonBody({displayName:formValue(form,'name'),phone:formValue(form,'phone'),companyName:formValue(form,'company')||undefined,email:formValue(form,'email')||undefined,city:formValue(form,'city')||undefined,countryCode:'TR',source:'manual'})}); form.reset(); load(); notify('Kişi eklendi.','success'); } catch(error){notify(error instanceof Error?error.message:'Kişi eklenemedi.','error');} }
  async function importCsv(file: File, commit: boolean) { try { const csv=await file.text(); const result=await api<Record<string,unknown>>('/api/contacts/import-csv',{method:'POST',...jsonBody({csv,defaultCountryCode:'TR',commit})}); setImportResult(result); if(commit){load();notify('Uygun kişiler içe aktarıldı.','success');} } catch(error){notify(error instanceof Error?error.message:'CSV işlenemedi.','error');} }
  async function exportContact(id:string){try{const result=await api<Record<string,unknown>>(`/api/contacts/${id}/export`);downloadJson(`musteri-${id}.json`,result);}catch(error){notify(error instanceof Error?error.message:'Dışa aktarılamadı.','error');}}
  async function deleteContact(item:Contact){const confirmPhone=window.prompt(`${item.display_name} kaydını kalıcı silmek için telefon numarasını yazın:`);if(!confirmPhone)return;try{await api(`/api/contacts/${item.id}`,{method:'DELETE',...jsonBody({confirmPhone})});load();notify('Müşteri ve bağlı kayıtları silindi.','success');}catch(error){notify(error instanceof Error?error.message:'Silinemedi.','error');}}
  return <div className="page-stack"><section className="panel"><div className="panel-heading"><div><h3>Kişiler</h3><p>Manuel kayıt, arama, CSV önizleme ve veri hakları.</p></div><input className="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="İsim, telefon veya firma ara" /></div><form className="form-grid" onSubmit={add}><label>İsim<input name="name" required /></label><label>Telefon<input name="phone" required placeholder="+905…" /></label><label>Firma<input name="company" /></label><label>E-posta<input name="email" type="email" /></label><label>Şehir<input name="city" /></label><div className="form-actions"><button className="button primary">Kişi Ekle</button></div></form></section><section className="panel"><div className="panel-heading"><div><h3>CSV İçe Aktarma</h3><p>telefon, isim, firma, sehir ve not kolonlarını destekler.</p></div></div><input className="csv-file-input" aria-label="CSV dosyasını kontrol etmek için seç" type="file" accept=".csv,text/csv" onChange={event=>{const file=event.target.files?.[0];if(file)void importCsv(file,false);}} />{importResult&&<div className="summary-grid">{Object.entries(importResult).filter(([,value])=>typeof value==='number').map(([key,value])=><div key={key}><span>{key}</span><strong>{String(value)}</strong></div>)}</div>}{importResult&&<label className="file-commit"><input className="csv-file-input" aria-label="Kontrol edilen CSV dosyasını içe aktarmak için seç" type="file" accept=".csv,text/csv" onChange={event=>{const file=event.target.files?.[0];if(file)void importCsv(file,true);}} />Kontrol edilen CSV’yi seçip içe aktar</label>}</section><section className="panel table-panel"><table><thead><tr><th>Kişi</th><th>Telefon</th><th>Firma</th><th>Durum</th><th>Kaynak</th><th>İşlem</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td><strong>{item.display_name}</strong><small>{item.email||item.city||'—'}</small></td><td>{item.phone_e164}</td><td>{item.company_name||'—'}</td><td>{item.status}</td><td>{item.source}</td><td><button className="text-button" onClick={()=>void exportContact(item.id)}>Dışa aktar</button><button className="text-button danger" onClick={()=>void deleteContact(item)}>Sil</button></td></tr>)}</tbody></table>{!items.length&&<Empty text="Henüz kişi yok." />}</section></div>;
}

type FileRow={id:string;conversation_id:string;contact_id:string;original_name:string;mime_type:string;size_bytes:number;source:string;scan_status:string;created_at:string;display_name:string;phone_e164:string};
export function FilesPage({notify}:{notify:Notify}){const[items,setItems]=useState<FileRow[]>([]);useEffect(()=>{void api<FileRow[]>('/api/files').then(setItems).catch(error=>notify(error.message,'error'));},[notify]);return <section className="panel table-panel"><div className="panel-heading"><div><h3>Özel Dosyalar</h3><p>R2 bucket public değildir; indirme yetkili Worker ve konuşma ilişkisi üzerinden yapılır.</p></div></div><table><thead><tr><th>Dosya</th><th>Müşteri</th><th>Tür/Boyut</th><th>Kaynak</th><th>Tarih</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td><a href={`/api/conversations/${item.conversation_id}/attachments/${item.id}`}><strong>{item.original_name}</strong></a><small>{item.scan_status}</small></td><td>{item.display_name}<small>{item.phone_e164}</small></td><td>{item.mime_type}<small>{formatBytes(item.size_bytes)}</small></td><td>{item.source}</td><td>{formatDate(item.created_at)}</td></tr>)}</tbody></table>{!items.length&&<Empty text="Henüz dosya yok." />}</section>}

type Notification={id:string;type:string;priority:string;status:string;title:string;body:string;created_at:string};
export function NotificationsPage({notify}:{notify:Notify}){const[items,setItems]=useState<Notification[]>([]);const load=useCallback(()=>void api<Notification[]>('/api/notifications').then(setItems).catch(error=>notify(error.message,'error')),[notify]);useEffect(()=>{load();},[load]);async function update(id:string,status:string){try{await api(`/api/notifications/${id}/status`,{method:'PUT',...jsonBody({status})});load();}catch(error){notify(error instanceof Error?error.message:'Güncellenemedi.','error');}}return <section className="panel"><div className="panel-heading"><div><h3>Bildirim Merkezi</h3><p>AI devri, hata, takip ve önemli müşteri uyarıları kalıcı olarak tutulur.</p></div></div><div className="notification-list">{items.map(item=><article className={`notification ${item.priority}`} key={item.id}><div><span>{item.type} · {formatDate(item.created_at)}</span><h4>{item.title}</h4><p>{item.body}</p></div><select value={item.status} onChange={event=>void update(item.id,event.target.value)}><option value="unread">Okunmadı</option><option value="read">Okundu</option><option value="in_progress">İşlemde</option><option value="snoozed">Ertelendi</option><option value="completed">Tamamlandı</option><option value="dismissed">Kapatıldı</option></select></article>)}</div>{!items.length&&<Empty text="Henüz bildirim yok." />}</section>}

type ReportOverview={daily:Array<{day:string;total:number}>;delivery:Array<{status:string;total:number}>;openHandoffs:number;leadStages:Array<{stage:string;total:number}>;ai:{total:number;neurons:number}};
export function ReportsPage({notify}:{notify:Notify}){const[data,setData]=useState<ReportOverview|null>(null);const[usage,setUsage]=useState<AiUsage|null>(null);useEffect(()=>{void Promise.all([api<ReportOverview>('/api/reports/overview'),api<AiUsage>('/api/ai/usage')]).then(([overview,neuron])=>{setData(overview);setUsage(neuron);}).catch((error:Error)=>notify(error.message,'error'));},[notify]);return <div className="page-stack"><section className="metrics"><article className="metric"><span>Açık insan devri</span><strong>{data?.openHandoffs??'—'}</strong></article><article className="metric"><span>30 günlük AI işlemi</span><strong>{data?.ai?.total??'—'}</strong></article><article className="metric"><span>Bugün kullanılan Neuron</span><strong>{formatNumber(usage?.usedNeurons)}</strong></article><article className="metric"><span>Mevcut günlük hak</span><strong>{formatNumber(usage?.entitlementNeurons)}</strong></article><article className="metric"><span>Kalan hak</span><strong>{formatNumber(usage?.remainingNeurons)}</strong></article><article className="metric"><span>Aşım</span><strong>{formatNumber(usage?.overageNeurons)}</strong></article><article className="metric"><span>Kullanım</span><strong>%{formatNumber(usage?.usagePercent)}</strong></article><article className="metric"><span>Giriş / çıkış tokeni</span><strong>{formatNumber(usage?.inputTokens)} / {formatNumber(usage?.outputTokens)}</strong></article></section><section className="panel"><h3>30 Günlük Mesaj Trafiği</h3><div className="bar-list">{(data?.daily??[]).map(row=><div key={row.day}><span>{row.day}</span><div><i style={{width:`${Math.min(100,Number(row.total)*3)}%`}} /></div><strong>{row.total}</strong></div>)}</div>{!data?.daily?.length&&<Empty text="Rapor oluşturmak için henüz veri yok." />}</section><section className="grid-two"><div className="panel"><h3>Teslim Durumları</h3>{(data?.delivery??[]).map(row=><p className="key-value" key={row.status}><span>{row.status}</span><strong>{row.total}</strong></p>)}</div><div className="panel"><h3>Müşteri Aşamaları</h3>{(data?.leadStages??[]).map(row=><p className="key-value" key={row.stage}><span>{row.stage}</span><strong>{row.total}</strong></p>)}</div></section></div>}

export function Empty({text}:{text:string}){return <div className="empty">{text}</div>}
export function formatNumber(value:unknown){const number=Number(value);return Number.isFinite(number)?number.toLocaleString('tr-TR',{maximumFractionDigits:6}):'—';}
export function formatDate(value:string|null|undefined){if(!value)return '—';return new Intl.DateTimeFormat('tr-TR',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Istanbul'}).format(new Date(value));}
function formatBytes(size:number){if(size<1024)return `${size} B`;if(size<1024*1024)return `${(size/1024).toFixed(1)} KB`;return `${(size/1024/1024).toFixed(1)} MB`;}
function downloadJson(name:string,value:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();URL.revokeObjectURL(url);}
