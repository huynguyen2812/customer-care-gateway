import { isQuietHour } from '../src/common/quiet-hours';

describe('quiet hours', () => {
  it('blocks overnight quiet hours', () => {
    expect(isQuietHour(new Date('2026-09-23T15:30:00.000Z'))).toBe(true);
    expect(isQuietHour(new Date('2026-09-23T03:00:00.000Z'))).toBe(false);
  });
});
