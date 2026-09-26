import { Injectable } from '@nestjs/common';
import { SourceConnection } from '@prisma/client';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { LocalCredentialsService } from './local-credentials.service';

/**
 * Client for "VETCLINIC Source Connector v1" (docs/standalone/source-connector-v1.md). Same shape as the
 * PETCLINIC connector (paged read, dry-run on the CRM side, revalidate right before sending), but every
 * request is HMAC-signed with the tenant's self-issued credential instead of carrying a bearer token.
 */
export const CONNECTOR_SIGNATURE_PREFIX = 'VCSC1';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const PAGE_SIZE = 500;
const MAX_PAGES = 200;

export type ConnectorConsent = { status: string; channel: string; purpose: string };
export type SourceAppointment = {
  id: string; appointmentAt: Date; status: string; revision: string; branchId: string | null;
  customerName: string; phone: string; petName: string; serviceName: string; consent: ConnectorConsent | null;
};
export type SourceReceivable = {
  id: string; documentCode: string; customerName: string; phone: string; remainingAmount: number; dueAt: string | null;
  branchId: string | null; revision: string; consent: ConnectorConsent | null;
};

const text = (v: unknown) => (v == null ? '' : String(v).trim());
const ID = /^[A-Za-z0-9._:-]{1,120}$/;

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** HTTPS, or loopback, or (explicit opt-in) plain HTTP on a private LAN address. Never credentials in the URL. */
export function assertConnectorBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('SOURCE_URL_INVALID'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('SOURCE_URL_INVALID');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const lanHttp = process.env.STANDALONE_ALLOW_HTTP_LAN_SOURCES === 'true' && isPrivateIpv4(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || lanHttp))) throw new Error('SOURCE_URL_INSECURE');
  return url;
}

export function connectorCanonical(method: string, pathAndQuery: string, timestamp: string, nonce: string, body: string): string {
  return `${CONNECTOR_SIGNATURE_PREFIX}\n${method.toUpperCase()}\n${pathAndQuery}\n${timestamp}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`;
}

export function signConnectorRequest(signingKey: string, method: string, pathAndQuery: string, timestamp: string, nonce: string, body: string): string {
  return createHmac('sha256', signingKey).update(connectorCanonical(method, pathAndQuery, timestamp, nonce, body)).digest('hex');
}

function consentOf(v: any): ConnectorConsent | null {
  if (!v || typeof v !== 'object') return null;
  return { status: text(v.status).toUpperCase(), channel: text(v.channel).toUpperCase(), purpose: text(v.purpose).toUpperCase() };
}

/**
 * Appointment reminders over Zalo are allowed by default (GRANTED or DEFAULT_ALLOWED); an explicit
 * REVOKED/WITHDRAWN/OPTED_OUT always wins; a missing consent record is not consent. The default never
 * applies to any other purpose or channel (see commit 5581357).
 */
export function appointmentConsentAllowed(c: ConnectorConsent | null): boolean {
  if (!c) return false;
  if (['REVOKED', 'WITHDRAWN', 'OPTED_OUT'].includes(c.status)) return false;
  if (c.channel && c.channel !== 'ZALO') return false;
  if (c.purpose && c.purpose !== 'APPOINTMENT_REMINDER') return false;
  return c.status === 'GRANTED' || c.status === 'DEFAULT_ALLOWED';
}

/** Debt reminders need an explicit GRANTED for Zalo debt reminders; no default applies. */
export function receivableConsentAllowed(c: ConnectorConsent | null): boolean {
  if (!c || c.status !== 'GRANTED') return false;
  if (c.channel && c.channel !== 'ZALO') return false;
  if (c.purpose && c.purpose !== 'DEBT_REMINDER') return false;
  return true;
}

export function normalizeSourceAppointment(v: any): SourceAppointment | null {
  const id = text(v?.id); const at = new Date(v?.appointmentAt);
  if (!ID.test(id) || Number.isNaN(at.getTime())) return null;
  return {
    id, appointmentAt: at, status: text(v.status).toUpperCase(), revision: text(v.revision), branchId: text(v.branchId) || null,
    customerName: text(v.customer?.name), phone: text(v.customer?.phone), petName: text(v.pet?.name), serviceName: text(v.serviceName),
    consent: consentOf(v.consent),
  };
}

export function normalizeSourceReceivable(v: any): SourceReceivable | null {
  const id = text(v?.id); const amount = Number(v?.remainingAmount);
  if (!ID.test(id) || !Number.isFinite(amount)) return null;
  return {
    id, documentCode: text(v.documentCode), customerName: text(v.customer?.name), phone: text(v.customer?.phone), remainingAmount: amount,
    dueAt: v.dueAt ? text(v.dueAt) : null, branchId: text(v.branchId) || null, revision: text(v.revision), consent: consentOf(v.consent),
  };
}

@Injectable()
export class SourceConnectorClient {
  constructor(private readonly credentials: LocalCredentialsService) {}

  private async call(connection: SourceConnection, method: 'GET' | 'POST', relPath: string, query: Record<string, string> = {}, body?: unknown): Promise<any> {
    const base = assertConnectorBaseUrl(connection.apiBaseUrl);
    const url = new URL(relPath.replace(/^\//, ''), `${base.toString().replace(/\/?$/, '/')}`);
    if (url.origin !== base.origin) throw new Error('SOURCE_URL_INVALID');
    Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    const { clientId, signingKey } = await this.credentials.outboundKey(connection.installationId);
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Date.now().toString(); const nonce = randomBytes(16).toString('base64url');
    const pathAndQuery = `${url.pathname}${url.search}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(10_000), body: body === undefined ? undefined : raw,
        headers: {
          accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'x-care-client-id': clientId, 'x-care-timestamp': timestamp, 'x-care-nonce': nonce,
          'x-care-signature': signConnectorRequest(signingKey, method, pathAndQuery, timestamp, nonce, raw),
        },
      });
    } catch { throw new Error('SOURCE_UNAVAILABLE'); }
    if (!res.ok) throw new Error(`SOURCE_HTTP_${res.status}`);
    const textBody = await res.text();
    if (Buffer.byteLength(textBody) > MAX_BODY_BYTES) throw new Error('SOURCE_RESPONSE_TOO_LARGE');
    try { return JSON.parse(textBody); } catch { throw new Error('SOURCE_RESPONSE_INVALID'); }
  }

  private async paged<T>(connection: SourceConnection, relPath: string, query: Record<string, string>, map: (v: any) => T | null): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.call(connection, 'GET', relPath, { ...query, page: String(page), size: String(PAGE_SIZE) });
      const items = Array.isArray(body?.data?.items) ? body.data.items : null;
      if (!items) throw new Error('SOURCE_RESPONSE_INVALID');
      out.push(...items.map(map).filter((x: T | null): x is T => x !== null));
      const totalPages = Number(body.data.totalPages);
      if (body.data.last === true || items.length < PAGE_SIZE || (Number.isInteger(totalPages) && page + 1 >= totalPages)) return out;
    }
    throw new Error('SOURCE_PAGINATION_LIMIT');
  }

  appointments(connection: SourceConnection, from: Date, to: Date) {
    return this.paged(connection, 'appointments', { from: from.toISOString(), to: to.toISOString() }, normalizeSourceAppointment);
  }

  receivables(connection: SourceConnection) {
    return this.paged(connection, 'receivables', {}, normalizeSourceReceivable);
  }

  /** Only an explicit eligible=true / ELIGIBLE for the same id may send; anything else fails closed. */
  async revalidateAppointment(connection: SourceConnection, id: string, expectedAppointmentTime: Date, expectedRevision: string): Promise<boolean> {
    const body = await this.call(connection, 'POST', `appointments/${encodeURIComponent(id)}/revalidate`, {}, { expectedAppointmentTime: expectedAppointmentTime.toISOString(), expectedRevision });
    return body?.data?.eligible === true && body?.data?.reasonCode === 'ELIGIBLE' && String(body?.data?.appointmentId ?? '') === id;
  }

  async revalidateReceivable(connection: SourceConnection, id: string, expectedRevision: string): Promise<boolean> {
    const body = await this.call(connection, 'POST', `receivables/${encodeURIComponent(id)}/revalidate`, {}, { expectedRevision });
    return body?.data?.eligible === true && body?.data?.reasonCode === 'ELIGIBLE' && String(body?.data?.receivableId ?? '') === id && Number(body?.data?.remainingAmount) > 0;
  }
}
