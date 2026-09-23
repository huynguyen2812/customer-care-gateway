import { maskPhone, normalizeVietnamPhone } from '../src/common/phone';

describe('phone helpers', () => {
  it.each([['0901234567', '+84901234567'], ['84901234567', '+84901234567'], ['+84 901 234 567', '+84901234567']])('normalizes %s', (input, expected) => expect(normalizeVietnamPhone(input)).toBe(expected));
  it('rejects invalid input', () => expect(() => normalizeVietnamPhone('123')).toThrow());
  it('masks logs', () => expect(maskPhone('+84901234567')).toBe('+8490***567'));
});
