import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PlatformDeviceApi, PlatformError, RedeemRequest, RedeemResponse, requestCanonical, SyncRequest, SyncResponse } from './platform-device.contract';
import { sha256Hex, signWithDevice } from './platform-crypto';

const MAX_BODY = 256 * 1024;

/**
 * Base URL comes ONLY from the release configuration (launcher → PLATFORM_DEVICE_API_URL), never from a request.
 * HTTPS is mandatory; plain http is accepted only for loopback with the explicit test/dev flag.
 */
export function platformBaseUrl(): URL {
  const raw = process.env.PLATFORM_DEVICE_API_URL || '';
  if (!raw) throw new PlatformError('PLATFORM_NOT_CONFIGURED');
  let url: URL;
  try { url = new URL(raw); } catch { throw new PlatformError('PLATFORM_NOT_CONFIGURED'); }
  const localDev = process.env.PLATFORM_DEVICE_ALLOW_INSECURE_LOCAL === '1' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localDev) || url.username || url.password || url.search || url.hash) throw new PlatformError('PLATFORM_URL_INSECURE');
  return url;
}

@Injectable()
export class HttpPlatformDeviceClient implements PlatformDeviceApi {
  private async post<T>(path: string, body: unknown, auth?: { deviceId: string; privateKeyPem: string }): Promise<T> {
    const base = platformBaseUrl();
    const url = new URL(path.replace(/^\//, ''), `${base.toString().replace(/\/?$/, '/')}`);
    const raw = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (auth) {
      const ts = Date.now().toString(); const nonce = randomBytes(16).toString('base64url');
      headers['x-vc-device-id'] = auth.deviceId; headers['x-vc-timestamp'] = ts; headers['x-vc-nonce'] = nonce;
      headers['x-vc-signature'] = signWithDevice(auth.privateKeyPem, requestCanonical('POST', url.pathname, ts, nonce, sha256Hex(raw)));
    }
    let res: Response;
    try { res = await fetch(url, { method: 'POST', headers, body: raw, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw new PlatformError('PLATFORM_UNREACHABLE'); }
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_BODY) throw new PlatformError('PLATFORM_RESPONSE_INVALID', res.status);
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const code = typeof json?.code === 'string' && /^[A-Z][A-Z0-9_]{2,60}$/.test(json.code) ? json.code : `PLATFORM_HTTP_${res.status}`;
      throw new PlatformError(code, res.status);
    }
    if (!json) throw new PlatformError('PLATFORM_RESPONSE_INVALID', res.status);
    return json as T;
  }

  redeem(req: RedeemRequest) { return this.post<RedeemResponse>('devices/redeem', req); }
  sync(deviceId: string, privateKeyPem: string, req: SyncRequest) { return this.post<SyncResponse>(`devices/${encodeURIComponent(deviceId)}/sync`, req, { deviceId, privateKeyPem }); }
  async unpair(deviceId: string, privateKeyPem: string) { await this.post(`devices/${encodeURIComponent(deviceId)}/unpair`, {}, { deviceId, privateKeyPem }); }
}
