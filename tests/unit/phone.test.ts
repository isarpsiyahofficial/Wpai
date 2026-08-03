import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone } from '../../src/shared/phone';

describe('normalizePhone', () => {
  it.each([
    ['05321234567', '+905321234567'],
    ['5321234567', '+905321234567'],
    ['905321234567', '+905321234567'],
    ['+905321234567', '+905321234567'],
    ['(0532) 123-45-67', '+905321234567']
  ])('normalizes Turkish mobile %s', (input, expected) => {
    expect(normalizePhone(input, 'TR')).toEqual({ ok: true, e164: expected, countryCode: 'TR' });
  });

  it.each(['', '123', '0532ABC4567', '+90+5321234567', '02121234567'])('rejects invalid value %s', input => {
    expect(normalizePhone(input, 'TR').ok).toBe(false);
  });

  it('requires an explicit prefix outside Turkey', () => {
    expect(normalizePhone('501234567', 'DE')).toEqual({ ok: false, reason: 'country_code_required' });
    expect(normalizePhone('+4915123456789', 'DE')).toEqual({ ok: true, e164: '+4915123456789', countryCode: 'DE' });
  });
});

describe('maskPhone', () => {
  it('does not reveal the full number', () => {
    const masked = maskPhone('+905321234567');
    expect(masked).toBe('+90 *** *** 4567');
    expect(masked).not.toContain('532123');
  });
});
