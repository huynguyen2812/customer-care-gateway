import { localDateStartUtc, shiftDateKey } from '../src/common/zoned-time';

describe('tenant calendar timezone', () => {
  it('maps Vietnam local midnight to the preceding UTC instant', () => {
    expect(localDateStartUtc('2026-09-25', 'Asia/Ho_Chi_Minh')?.toISOString()).toBe('2026-09-24T17:00:00.000Z');
    expect(localDateStartUtc('2026-09-26', 'Asia/Ho_Chi_Minh')?.toISOString()).toBe('2026-09-25T17:00:00.000Z');
  });

  it('shifts calendar keys without using the server timezone', () => {
    expect(shiftDateKey('2026-09-25', 1)).toBe('2026-09-26');
    expect(shiftDateKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDateKey('not-a-date', 1)).toBeNull();
  });
});
