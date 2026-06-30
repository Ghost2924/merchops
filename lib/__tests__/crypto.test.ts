import { encrypt, decrypt } from '../crypto';

describe('Crypto Utility', () => {
  it('should encrypt and decrypt correctly', () => {
    const secret = 'super-secret-api-key-12345';
    const encrypted = encrypt(secret);
    
    expect(encrypted).not.toBe(secret);
    expect(encrypted.split(':')).toHaveLength(3);
    
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(secret);
  });

  it('should return empty string for empty input', () => {
    expect(encrypt('')).toBe('');
    expect(decrypt('')).toBe('');
  });

  it('should produce different ciphertexts for the same plaintext due to random IV', () => {
    const secret = 'same-plaintext';
    const encrypted1 = encrypt(secret);
    const encrypted2 = encrypt(secret);
    
    expect(encrypted1).not.toBe(encrypted2);
    expect(decrypt(encrypted1)).toBe(secret);
    expect(decrypt(encrypted2)).toBe(secret);
  });

  it('should throw error on invalid format', () => {
    expect(() => decrypt('invalid-format')).toThrow();
    expect(() => decrypt('part1:part2')).toThrow();
  });
});
