import { describe, expect, it } from 'vitest';
import { estimateNeurons, extractMonetaryClaims } from '../../src/worker/ai';

describe('AI critical monetary claims', () => {
  it('extracts Turkish and international currency amounts without treating durations as prices', () => {
    expect(extractMonetaryClaims('Kurumsal site 15.000 TL, ek modül 250,50 EUR ve 100 USD olur. 24 saat içinde döneriz.')).toEqual([
      { amount: 15000, currency: 'TRY', raw: '15.000 TL' },
      { amount: 250.5, currency: 'EUR', raw: '250,50 EUR' },
      { amount: 100, currency: 'USD', raw: '100 USD' }
    ]);
  });

  it('normalizes currency symbols and leading currency markers', () => {
    expect(extractMonetaryClaims('₺12.500, $99.90 ve € 1.250')).toEqual([
      { amount: 12500, currency: 'TRY', raw: '₺12.500' },
      { amount: 99.9, currency: 'USD', raw: '$99.90' },
      { amount: 1250, currency: 'EUR', raw: '€ 1.250' }
    ]);
  });

  it('uses the published per-token Neuron coefficients for the configured models', () => {
    expect(estimateNeurons('@cf/meta/llama-3.1-8b-instruct-fast', 1_000_000, 1_000_000)).toBeCloseTo(38987, 5);
    expect(estimateNeurons('@cf/baai/bge-m3', 1_000_000, 0)).toBeCloseTo(1075, 5);
    expect(estimateNeurons('unknown', 1000, 1000)).toBe(0);
  });
});
