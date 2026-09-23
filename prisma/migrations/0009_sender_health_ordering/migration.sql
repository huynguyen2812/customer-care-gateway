-- Forward-only: mốc sự kiện health đã áp dụng cho từng account. Cập nhật trạng thái từ health callback là
-- UPDATE có điều kiện "lastSenderEventAt IS NULL OR < occurredAt" → nguyên tử, sự kiện cũ commit sau không ghi đè.
ALTER TABLE "ZaloAccount" ADD COLUMN "lastSenderEventAt" TIMESTAMP(3);
-- Backfill từ các sự kiện đã áp dụng (nếu có) để thứ tự tiếp tục đúng sau khi nâng cấp.
UPDATE "ZaloAccount" z SET "lastSenderEventAt" = e.max_at
FROM (SELECT "zaloAccountId", MAX("occurredAt") AS max_at FROM "SenderHealthEvent" WHERE "result" = 'APPLIED' GROUP BY "zaloAccountId") e
WHERE e."zaloAccountId" = z."id";
