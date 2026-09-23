import { BadRequestException, Body, Controller, HttpCode, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Prisma, ZaloAccountStatus } from '@prisma/client';
import { Request } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SKEW_MS = 300_000;
const STATUS: Record<string, ZaloAccountStatus> = {
  CONNECTED: 'CONNECTED', DISCONNECTED: 'DISCONNECTED', RELOGIN_REQUIRED: 'RELOGIN_REQUIRED', RESTRICTED: 'RESTRICTED', PAUSED: 'PAUSED',
};
type RawRequest = Request & { rawBody?: Buffer };

/**
 * Health callback sender v2 → Gateway (docs/multi-zalo-sender-contract.md §8).
 * `x-sender-signature = hex(HMAC-SHA256(signingKey, METHOD\nPATH\nTS\nNONCE\nSHA256(rawBody)))` với signing key
 * của CHÍNH account trong path (sender client đã đăng ký account đó). Tenant lấy từ account trong DB, không bao giờ
 * từ request. Mọi lỗi xác thực trả cùng một 401 (không lộ account có tồn tại hay không).
 * Chống replay: timestamp ±5 phút + nonce duy nhất theo sender client; eventId trùng → trả lại kết quả, không áp dụng lại.
 * Chỉ sự kiện mới hơn sự kiện đã áp dụng gần nhất (ZaloAccount.lastSenderEventAt) mới đổi trạng thái — quyết định bằng
 * UPDATE có điều kiện trong PostgreSQL nên an toàn khi callback chạy đồng thời hoặc commit đảo thứ tự.
 */
@Controller('channel/accounts')
export class SenderHealthController {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

  @Post(':id/health')
  @HttpCode(200)
  async receive(@Param('id') id: string, @Req() req: RawRequest, @Body() body: Record<string, unknown>) {
    const unauthorized = new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Invalid sender signature' });
    const h = (k: string) => { const v = req.headers[k]; return Array.isArray(v) ? '' : String(v ?? ''); };
    const clientId = h('x-sender-client-id'); const timestamp = h('x-sender-timestamp'); const nonce = h('x-sender-nonce');
    const eventId = h('x-sender-event-id'); const headerAccount = h('x-sender-account-id').toLowerCase(); const signature = h('x-sender-signature');
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!UUID.test(id) || headerAccount !== id.toLowerCase() || !/^[A-Za-z0-9._:-]{3,100}$/.test(clientId) || !/^\d{10,16}$/.test(timestamp)
      || !/^[A-Za-z0-9_-]{8,80}$/.test(nonce) || !UUID.test(eventId) || !/^[a-f0-9]{64}$/.test(signature) || !raw) throw unauthorized;

    const account = await this.prisma.zaloAccount.findUnique({ where: { id: id.toLowerCase() } });
    // Account phải được đăng ký bởi ĐÚNG sender client đang ký callback (account tenant khác / client khác → 401).
    if (!account || !account.credentialEnc || !account.senderClientId || account.senderClientId !== clientId) throw unauthorized;
    let key: string;
    try { key = this.crypto.decrypt(account.credentialEnc); } catch { throw unauthorized; }
    const expected = createHmac('sha256', key).update(`${req.method}\n${req.path}\n${timestamp}\n${nonce}\n${createHash('sha256').update(raw).digest('hex')}`).digest('hex');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw unauthorized;
    if (Math.abs(Date.now() - Number(timestamp)) > MAX_SKEW_MS) throw unauthorized;
    try {
      await this.prisma.controlNonce.create({ data: { clientId: `sender:${clientId}`.slice(0, 80), nonce } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw unauthorized; // nonce lặp = replay
      throw e;
    }

    const status = STATUS[String(body?.status ?? '')];
    const at = new Date(String(body?.at ?? ''));
    const reason = body?.reason === null || body?.reason === undefined ? null : String(body.reason);
    if (!status || Number.isNaN(at.getTime()) || (reason !== null && !/^[A-Z0-9_]{1,80}$/.test(reason))) throw new BadRequestException({ code: 'VALIDATION', message: 'Invalid health event' });

    // Idempotency + thứ tự được quyết định NGUYÊN TỬ trong PostgreSQL, không dựa vào `account` đã đọc trước:
    //  1) INSERT sự kiện ON CONFLICT(eventId) DO NOTHING — eventId trùng (kể cả đồng thời) chỉ một bên chèn được;
    //     bên còn lại chờ bên kia commit rồi nhận "không chèn" → trả kết quả đã lưu.
    //  2) UPDATE account CÓ ĐIỀU KIỆN: chưa thu hồi, lastSenderEventAt IS NULL OR < occurredAt, và (PAUSED ⇒ đang CONNECTED).
    //     Hai UPDATE cùng dòng bị PostgreSQL tuần tự hoá; bên chờ đánh giá lại điều kiện trên dữ liệu đã commit, nên sự
    //     kiện cũ commit sau không thể ghi đè sự kiện mới.
    //  3) Không cập nhật được → đọc dòng đã commit (KHÔNG khoá: SELECT … FOR UPDATE ở đây xung đột với khoá KEY SHARE do
    //     INSERT sự kiện (khoá ngoại) của transaction khác giữ → deadlock 40P01) chỉ để ghi lý do STALE / IGNORED.
    const outcome = await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO "SenderHealthEvent" ("eventId", "tenantId", "zaloAccountId", "status", "reason", "occurredAt", "result")
        VALUES (${eventId}::uuid, ${account.tenantId}::uuid, ${account.id}::uuid, ${status}, ${reason}, ${at}, 'PENDING')
        ON CONFLICT ("eventId") DO NOTHING`;
      if (!inserted) return { duplicate: true as const };
      const updated = await tx.zaloAccount.updateMany({
        where: {
          id: account.id, tenantId: account.tenantId, revokedAt: null, status: status === 'PAUSED' ? 'CONNECTED' : { not: 'REVOKED' },
          OR: [{ lastSenderEventAt: null }, { lastSenderEventAt: { lt: at } }],
        },
        data: {
          status, lastSenderEventAt: at,
          ...(status === 'CONNECTED' ? { lastConnectedAt: at, lastError: null } : {}),
          ...(status === 'RELOGIN_REQUIRED' ? { lastError: 'Phiên Zalo đã hết — cần đăng nhập lại.' } : {}),
        },
      });
      let result: 'APPLIED' | 'STALE' | 'IGNORED' = 'APPLIED';
      let previousStatus: string | null = null;
      if (!updated.count) {
        const cur = await tx.$queryRaw<{ status: string; revokedAt: Date | null; lastSenderEventAt: Date | null }[]>`
          SELECT "status", "revokedAt", "lastSenderEventAt" FROM "ZaloAccount" WHERE "id" = ${account.id}::uuid`;
        const row = cur[0];
        previousStatus = row?.status ?? null;
        result = !row || row.revokedAt || row.status === 'REVOKED' ? 'IGNORED'
          : row.lastSenderEventAt && row.lastSenderEventAt >= at ? 'STALE' : 'IGNORED'; // còn lại: PAUSED khi account không CONNECTED
      }
      await tx.senderHealthEvent.update({ where: { eventId }, data: { result } });
      await tx.auditLog.create({ data: { tenantId: account.tenantId, installationId: account.installationId, actorType: 'SENDER', actorId: clientId, action: 'ZALO_ACCOUNT_SENDER_HEALTH', targetType: 'ZaloAccount', targetId: account.id, result: result === 'APPLIED' ? 'SUCCESS' : 'NO_CHANGE', reason: result, metadata: { eventId, status, reason, ...(previousStatus ? { currentStatus: previousStatus } : {}) } } });
      return { duplicate: false as const, result };
    });
    if (!outcome.duplicate) return { accepted: true, eventId, result: outcome.result };
    const prev = await this.prisma.senderHealthEvent.findUnique({ where: { eventId } });
    // eventId đã dùng cho account khác → coi như lỗi xác thực (không lộ gì thêm).
    if (!prev || prev.zaloAccountId !== account.id) throw unauthorized;
    return { accepted: true, eventId, result: prev.result, duplicate: true };
  }
}
