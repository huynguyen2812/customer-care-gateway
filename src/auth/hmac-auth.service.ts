import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

@Injectable()
export class HmacAuthService {
  verify(secret: string, signature: string, canonical: string): void {
    const expected = createHmac('sha256', secret).update(canonical).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new UnauthorizedException('Invalid request authentication');
    }
  }
}
