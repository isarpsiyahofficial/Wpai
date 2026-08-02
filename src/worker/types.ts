export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  INBOUND_AI: Queue<InboundAiJob>;
  OUTBOUND: Queue<OutboundJob>;
  ADMIN_NOTIFY: Queue<AdminNotifyJob>;
  AI_DLQ: Queue<DeadLetterJob>;
  OUTBOUND_DLQ: Queue<DeadLetterJob>;
  AI: Ai;
  KNOWLEDGE_INDEX: VectorizeIndex;
  ASSETS: Fetcher;
  APP_ENV: string;
  DEFAULT_TIMEZONE: string;
  META_GRAPH_API_VERSION: string;
  DEFAULT_AI_MODEL: string;
  DEFAULT_EMBEDDING_MODEL: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  PROJECT_MANIFEST_VERSION: string;
  SESSION_SIGNING_KEY: string;
  DATA_ENCRYPTION_KEY: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
}

export type InboundAiJob = {
  jobId: string;
  conversationId: string;
  contactId: string;
  sourceMessageId: string;
  expectedLastMessageId: string;
  enqueuedAt: string;
};

export type OutboundJob = {
  jobId: string;
  conversationId: string;
  contactId: string;
  messageId: string;
  kind: 'text' | 'media' | 'template';
  expectedAiDecisionId?: string;
  enqueuedAt: string;
};

export type AdminNotifyJob = {
  jobId: string;
  notificationId: string;
  conversationId?: string;
  enqueuedAt: string;
};

export type DeadLetterJob = {
  sourceQueue: string;
  originalJob: unknown;
  errorCode: string;
  failedAt: string;
};

export type RequestVariables = {
  requestId: string;
  adminId?: string;
  sessionId?: string;
  csrfToken?: string;
};

export type AppContext = {
  Bindings: Env;
  Variables: RequestVariables;
};
