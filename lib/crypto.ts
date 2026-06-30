import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || process.env.CLERK_SECRET_KEY || 'default-saas-dashboard-encryption-fallback-key-32bytes-long';

// Derive a 32-byte key from the configured key using scrypt
const key = crypto.scryptSync(ENCRYPTION_KEY, 'saas-dashboard-salt', 32);

/**
 * Encrypts cleartext using AES-256-GCM
 */
export function encrypt(text: string): string {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag().toString('hex');
  
  // Format: iv:encryptedData:tag
  return `${iv.toString('hex')}:${encrypted}:${tag}`;
}

/**
 * Decrypts ciphertext using AES-256-GCM
 */
export function decrypt(encrypted: string): string {
  if (!encrypted) return '';
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted credentials format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  return decrypted.toString('utf8');
}
