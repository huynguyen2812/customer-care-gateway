import { Injectable } from '@nestjs/common';
import { PetclinicConnection } from '@prisma/client';
import { CryptoService } from '../common/crypto.service';
import { normalizeAppointment, PetclinicAppointment } from './petclinic.types';

function safeApiUrl(base: string, path: string, params: Record<string, string>): URL {
  const root = new URL(base);
  if (root.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && ['127.0.0.1', 'localhost'].includes(root.hostname))) throw new Error('PETCLINIC_API_REQUIRES_HTTPS');
  if (root.username || root.password) throw new Error('PETCLINIC_API_URL_CREDENTIALS_FORBIDDEN');
  const url = new URL(path, `${root.origin}/`);
  if (url.origin !== root.origin) throw new Error('PETCLINIC_API_ORIGIN_MISMATCH');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

@Injectable()
export class PetclinicClientService {
  constructor(private readonly crypto: CryptoService) {}

  async list(connection: PetclinicConnection, from: Date, to: Date): Promise<PetclinicAppointment[]> {
    const url = safeApiUrl(connection.apiBaseUrl, connection.appointmentsPath, {
      page: '0', size: '1000', sort: 'appointmentTime,asc',
      from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10),
    });
    const response = await fetch(url, { headers: {
      authorization: `Bearer ${this.crypto.decrypt(connection.apiTokenEnc)}`,
      'x-tenant-id': connection.apiTenantId,
      accept: 'application/json',
    }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`PETCLINIC_HTTP_${response.status}`);
    const body = await response.json() as any;
    const rows = Array.isArray(body?.data?.content) ? body.data.content : [];
    return rows.map((row: any) => normalizeAppointment(row)).filter((row: PetclinicAppointment | null): row is PetclinicAppointment => row !== null);
  }
}

export { safeApiUrl };
