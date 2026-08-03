import { describe, expect, it } from 'vitest';
import { chunkText } from '../../src/worker/ai';

describe('AI knowledge chunking', () => {
  it('normalizes whitespace and keeps overlap without infinite loops', () => {
    const text = Array.from({ length: 80 }, (_, index) => `Cümle ${index}. Bu işletme bilgisi doğrulanmıştır.`).join('\n');
    const chunks = chunkText(text, 240, 40);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every(chunk => chunk.length <= 240)).toBe(true);
    expect(chunks.join(' ')).toContain('Cümle 79');
  });

  it('returns no chunks for blank content', () => {
    expect(chunkText(' \n\n ', 100, 20)).toEqual([]);
  });

  it('handles a long word safely', () => {
    const chunks = chunkText('x'.repeat(1000), 150, 25);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)?.length).toBeLessThanOrEqual(150);
  });
});
