import { Hono } from 'hono';
import type { AppContext } from './types';
import { first } from './db';
import { fail, requireAuth } from './http';

export const scopedFileRoutes = new Hono<AppContext>();
scopedFileRoutes.use('*', requireAuth);

scopedFileRoutes.get('/conversations/:conversationId/attachments/:attachmentId', async c => {
  const conversationId = c.req.param('conversationId');
  const attachmentId = c.req.param('attachmentId');
  const row = await first<{ r2_key: string; original_name: string; mime_type: string }>(c.env.DB,
    `SELECT a.r2_key,a.original_name,a.mime_type
       FROM attachments a
       JOIN conversations v ON v.id=a.conversation_id AND v.contact_id=a.contact_id
      WHERE a.id=? AND a.conversation_id=? AND a.deleted_at IS NULL AND v.deleted_at IS NULL`,
    attachmentId, conversationId);
  if (!row) return fail(c, 'NOT_FOUND', 'Dosya bu konuşmaya ait değil veya bulunamadı.', 404);
  const object = await c.env.FILES.get(row.r2_key);
  if (!object) return fail(c, 'FILE_MISSING', 'Dosya depolama alanında bulunamadı.', 404);
  const headers = new Headers({
    'Content-Type': row.mime_type,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  return new Response(object.body, { headers });
});
