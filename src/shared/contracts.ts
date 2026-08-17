import { z } from 'zod';

export const AiModeSchema = z.enum(['off', 'suggestion', 'auto', 'business_hours', 'human']);
export type AiMode = z.infer<typeof AiModeSchema>;

export const MessageTypeSchema = z.enum([
  'text', 'image', 'document', 'audio', 'video', 'location', 'contact',
  'interactive', 'template', 'reaction', 'unsupported'
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

const AiRequirementValueSchema = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(500)).max(100)
]);

export const AiDecisionSchema = z.object({
  action: z.enum(['reply', 'clarify', 'handoff', 'no_reply', 'wait', 'blocked']),
  intent: z.string().min(1).max(80),
  confidence: z.number().min(0).max(1),
  needs_human: z.boolean(),
  needs_research: z.boolean(),
  should_notify_admin: z.boolean(),
  note_updates: z.array(z.object({ text: z.string().min(1).max(2000) })).max(10),
  requirement_updates: z.record(z.string(), AiRequirementValueSchema),
  reply: z.string().max(4000)
});
export type AiDecision = z.infer<typeof AiDecisionSchema>;

export const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256)
});

export const SetupAdminSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(254),
  password: z.string().min(6).max(256),
  bootstrapToken: z.string().min(24).max(512)
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(6).max(256),
  revokeOtherSessions: z.boolean().default(true)
});

export const ContactSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  phone: z.string().trim().min(7).max(32),
  companyName: z.string().trim().max(200).optional(),
  email: z.string().email().max(254).optional(),
  city: z.string().trim().max(120).optional(),
  countryCode: z.string().trim().length(2).optional(),
  source: z.string().trim().max(80).default('manual')
});

export const NewTemplateMessageSchema = z.object({
  phone: z.string().trim().min(7).max(32),
  displayName: z.string().trim().min(1).max(160),
  templateName: z.string().trim().min(1).max(512),
  languageCode: z.string().trim().min(2).max(20),
  variables: z.array(z.string().max(1024)).max(20).default([])
});

export const ManualMessageSchema = z.object({
  conversationId: z.string().uuid(),
  text: z.string().trim().min(1).max(4096),
  clientRequestId: z.string().uuid()
});

export const ConversationAiModeSchema = z.object({
  mode: AiModeSchema,
  pausedUntil: z.string().datetime().nullable().optional()
});

export const KnowledgeEntrySchema = z.object({
  title: z.string().trim().min(3).max(240),
  category: z.string().trim().min(2).max(100),
  content: z.string().trim().min(10).max(50000),
  status: z.enum(['draft', 'approved', 'disabled']).default('draft'),
  usagePermission: z.enum(['internal', 'customer_answers', 'both']).default('both')
});

export const AiInstructionsSchema = z.object({
  businessInstructions: z.string().max(30000),
  handoffRules: z.array(z.string().trim().min(2).max(500)).max(100),
  minimumConfidence: z.number().min(0.1).max(1),
  recentMessageCount: z.number().int().min(4).max(20),
  debounceSeconds: z.number().int().min(1).max(60)
});

export const MetaCredentialsSchema = z.object({
  accessToken: z.string().min(20).max(4096),
  appSecret: z.string().min(20).max(512),
  phoneNumberId: z.string().min(5).max(128),
  businessAccountId: z.string().min(5).max(128),
  verifyToken: z.string().min(20).max(512),
  adminWhatsAppPhone: z.string().max(32).optional()
});

export const CloudflareScanSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  apiToken: z.string().min(30).max(4096)
});

export type ApiError = { ok: false; error: { code: string; message: string; requestId: string } };
export type ApiSuccess<T> = { ok: true; data: T };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export type InfrastructureComponent = {
  key: string;
  label: string;
  status: 'ready' | 'missing' | 'misconfigured' | 'unknown' | 'blocked';
  current?: string;
  expected?: string;
  repairable: boolean;
  details?: string;
};

export type InfrastructureReport = {
  accountId: string;
  accountName: string;
  checkedAt: string;
  overall: 'ready' | 'repair_required' | 'blocked';
  components: InfrastructureComponent[];
  plan: Array<{ action: string; resource: string; destructive: boolean; paid: boolean }>;
};
