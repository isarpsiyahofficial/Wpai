import { describe, expect, it } from 'vitest';
import {
  AiDecisionSchema, AiInstructionsSchema, CloudflareScanSchema, ContactSchema,
  KnowledgeEntrySchema, ManualMessageSchema, MetaCredentialsSchema, SetupAdminSchema
} from '../../src/shared/contracts';

describe('API contracts', () => {
  it('accepts a structured AI reply and rejects out-of-range confidence', () => {
    const valid = {
      action: 'reply', intent: 'price_question', confidence: 0.91, needs_human: false,
      needs_research: false, should_notify_admin: false, note_updates: [],
      requirement_updates: { website_type: 'kurumsal' }, reply: 'Size yardımcı olayım.'
    };
    expect(AiDecisionSchema.parse(valid).action).toBe('reply');
    expect(() => AiDecisionSchema.parse({ ...valid, confidence: 1.2 })).toThrow();
  });

  it('enforces strong setup and message boundaries', () => {
    expect(() => SetupAdminSchema.parse({ name: 'A', email: 'bad', password: 'short', bootstrapToken: 'x' })).toThrow();
    expect(() => ManualMessageSchema.parse({ conversationId: 'not-a-uuid', text: '', clientRequestId: 'bad' })).toThrow();
    expect(ManualMessageSchema.parse({ conversationId: crypto.randomUUID(), text: 'Merhaba', clientRequestId: crypto.randomUUID() }).text).toBe('Merhaba');
  });

  it('limits AI instructions and handoff rules', () => {
    const value = AiInstructionsSchema.parse({
      businessInstructions: 'Yalnız doğrulanmış fiyatları kullan.',
      handoffRules: ['Özel indirim talebi', 'Hukuki soru'],
      minimumConfidence: 0.82, recentMessageCount: 10, debounceSeconds: 6
    });
    expect(value.handoffRules).toHaveLength(2);
    expect(() => AiInstructionsSchema.parse({ ...value, recentMessageCount: 100 })).toThrow();
  });

  it('validates contact, knowledge, Meta and Cloudflare payloads', () => {
    expect(ContactSchema.parse({ displayName: 'Ahmet', phone: '+905321234567' }).source).toBe('manual');
    expect(KnowledgeEntrySchema.parse({ title: 'Teslim süreci', category: 'Süreç', content: 'Teslimat kapsam onayından sonra başlar.' }).status).toBe('draft');
    expect(() => MetaCredentialsSchema.parse({ accessToken: 'x' })).toThrow();
    expect(CloudflareScanSchema.safeParse({ accountId: 'ad8e99c82c6c17d823f6877ff1efade4', apiToken: 'x'.repeat(35) }).success).toBe(true);
    expect(CloudflareScanSchema.safeParse({ accountId: 'wrong', apiToken: 'x'.repeat(35) }).success).toBe(false);
  });
});
