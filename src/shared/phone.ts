export type PhoneResult =
  | { ok: true; e164: string; countryCode: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'country_code_required' };

export function normalizePhone(input: string, defaultCountry = 'TR'): PhoneResult {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (/[A-Za-zÀ-ž]/u.test(raw)) return { ok: false, reason: 'invalid' };
  let digits = raw.replace(/[^0-9+]/g, '');
  if ((digits.match(/\+/g) ?? []).length > 1 || (digits.includes('+') && !digits.startsWith('+'))) {
    return { ok: false, reason: 'invalid' };
  }

  if (defaultCountry === 'TR') {
    digits = digits.replace(/^\+/, '');
    if (/^0?5\d{9}$/.test(digits)) digits = `90${digits.replace(/^0/, '')}`;
    else if (/^90?5\d{9}$/.test(digits)) digits = digits.startsWith('90') ? digits : `9${digits}`;
    if (!/^905\d{9}$/.test(digits)) return { ok: false, reason: 'invalid' };
    return { ok: true, e164: `+${digits}`, countryCode: 'TR' };
  }

  if (!raw.startsWith('+')) return { ok: false, reason: 'country_code_required' };
  digits = raw.replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) return { ok: false, reason: 'invalid' };
  return { ok: true, e164: `+${digits}`, countryCode: defaultCountry };
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `+${digits.slice(0, 2)} *** *** ${digits.slice(-4)}`;
}
