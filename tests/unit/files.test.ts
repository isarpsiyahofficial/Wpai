import { describe, expect, it } from 'vitest';
import { validateFileSignature } from '../../src/worker/files';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('file signature validation', () => {
  it('accepts matching PDF, PNG, JPEG and WEBP signatures', () => {
    expect(validateFileSignature('application/pdf', bytes(0x25,0x50,0x44,0x46,0x2d))).toBe(true);
    expect(validateFileSignature('image/png', bytes(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a))).toBe(true);
    expect(validateFileSignature('image/jpeg', bytes(0xff,0xd8,0xff,0xe0))).toBe(true);
    expect(validateFileSignature('image/webp', new TextEncoder().encode('RIFF0000WEBPVP8 '))).toBe(true);
  });

  it('rejects extension-only spoofing and executable content', () => {
    expect(validateFileSignature('application/pdf', new TextEncoder().encode('not a pdf'))).toBe(false);
    expect(validateFileSignature('application/x-msdownload', bytes(0x4d,0x5a))).toBe(false);
    expect(validateFileSignature('text/plain', bytes(65,66,0,67))).toBe(false);
  });
});
