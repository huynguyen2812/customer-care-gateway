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
    const token = this.token(connection);
    const out: PetclinicAppointment[] = [];
    for (let page = 0; page < 100; page++) {
      const url = safeApiUrl(connection.apiBaseUrl, connection.appointmentsPath, {
        page: String(page), size: '1000', sort: 'appointmentTime,asc',
        from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10),
      });
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`PETCLINIC_HTTP_${response.status}`);
      const body = await response.json() as any;
      const rows = Array.isArray(body?.data?.content) ? body.data.content : [];
      out.push(...rows.map((row: any) => normalizeAppointment(row)).filter((row: PetclinicAppointment | null): row is PetclinicAppointment => row !== null));
      const last = body?.data?.last === true;
      const totalPages = Number(body?.data?.totalPages);
      if (last || rows.length < 1000 || (Number.isInteger(totalPages) && page + 1 >= totalPages)) return out;
    }
    throw new Error('PETCLINIC_PAGINATION_LIMIT');
  }

  async revalidate(connection: PetclinicConnection, appointmentId: string, expectedAppointmentTime: Date, expectedRevision: string): Promise<boolean> {
    const url = safeApiUrl(connection.apiBaseUrl, `${connection.appointmentsPath}/${encodeURIComponent(appointmentId)}/revalidate`, {});
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token(connection)}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedAppointmentTime: expectedAppointmentTime.toISOString(), expectedRevision }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`PETCLINIC_REVALIDATE_HTTP_${response.status}`);
    const body = await response.json() as any;
    return body?.data?.eligible === true
      && body?.data?.reasonCode === 'ELIGIBLE'
      && String(body?.data?.appointmentId || '') === appointmentId;
  }

  private token(connection: PetclinicConnection): string {
    if (!connection.apiTokenEnc) throw new Error('PETCLINIC_CREDENTIAL_REVOKED');
    if (connection.credentialExpiresAt && connection.credentialExpiresAt <= new Date()) throw new Error('PETCLINIC_CREDENTIAL_EXPIRED');
    return this.crypto.decrypt(connection.apiTokenEnc);
  }
}

export { safeApiUrl };
