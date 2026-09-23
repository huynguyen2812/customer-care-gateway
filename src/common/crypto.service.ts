import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

@Injectable()
export class CryptoService {
  secretHash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  phoneHash(phoneE164: string): string {
    const pepper = process.env.PHONE_HASH_PEPPER;
    if (!pepper || pepper.length < 32) throw new Error('PHONE_HASH_PEPPER must be at least 32 characters');
    return createHmac('sha256', pepper).update(phoneE164).digest('hex');
  }

  encrypt(value: string): string {
    const encoded = process.env.DATA_ENCRYPTION_KEY_BASE64;
    if (!encoded) throw new Error('DATA_ENCRYPTION_KEY_BASE64 is required');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY_BASE64 must decode to 32 bytes');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
  }

  decrypt(blob: string): string {
    const key = Buffer.from(process.env.DATA_ENCRYPTION_KEY_BASE64 || '', 'base64');
    if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY_BASE64 must decode to 32 bytes');
    const [iv, tag, ciphertext] = blob.split('.').map((part) => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
