export type PageId = 'dashboard' | 'whatsapp' | 'contacts' | 'knowledge' | 'files' | 'ai' | 'training' | 'notifications' | 'reports' | 'settings';
export type Notify = (message: string, kind?: 'success' | 'error' | 'info') => void;
export type Admin = { id: string; name: string; email: string; role: string };
export type Health = { ok: boolean; components: Record<string, boolean | string | number | null | Record<string, unknown>> };
export type ConversationListItem = { id: string; contact_id: string; status: string; ai_mode: string; human_takeover: number; unread_count: number; last_message_at: string | null; display_name: string; phone_e164: string; company_name: string | null; last_message: string | null };
export type ConversationDetail = {
  conversation: Record<string, unknown> & { id: string; contact_id: string; display_name: string; phone_e164: string; company_name?: string | null; ai_mode: string; human_takeover: number; last_inbound_at?: string | null };
  messages: Array<Record<string, unknown> & { id: string; direction: 'inbound' | 'outbound'; sender_type: string; message_type: string; text_content: string | null; delivery_status: string; ai_generated: number; created_at: string; attachment_id?: string | null; original_name?: string | null }>;
  notes: Array<Record<string, unknown>>;
  requirements: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  handoff: Record<string, unknown> | null;
  lastDecision: Record<string, unknown> | null;
};
