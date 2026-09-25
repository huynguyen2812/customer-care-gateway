import { safeApiUrl } from '../src/petclinic/petclinic-client.service';
import { isReminderEligible, normalizeAppointment, parseSourceInstant } from '../src/petclinic/petclinic.types';

describe('operating PETCLINIC connector', () => {
  it('normalizes the observed appointment envelope fields without retaining the source object', () => {
    const appointment = normalizeAppointment({
      id: 'appt-1', appointmentTime: '2026-09-25T02:00:00.000Z', status: 'SCHEDULED',
      branch: { id: 'branch-1' }, owner: { fullName: 'Anh Huy', phoneNumber: '0900000000' },
      pet: { name: 'Miu' }, service: { name: 'Khám' }, messagingConsent: true,
      revision: 'revision-1',
      privateMedicalNote: 'must-not-be-copied',
    });
    expect(appointment).toEqual({ id: 'appt-1', appointmentAt: new Date('2026-09-25T02:00:00.000Z'), status: 'SCHEDULED', branchId: 'branch-1', ownerName: 'Anh Huy', phone: '0900000000', petName: 'Miu', serviceName: 'Khám', consentGranted: true, revision: 'revision-1' });
    expect(isReminderEligible(appointment!)).toBe(true);
    expect(appointment).not.toHaveProperty('privateMedicalNote');
  });

  it('rejects cancelled and incomplete appointments', () => {
    expect(isReminderEligible(normalizeAppointment({ id: '1', appointmentTime: '2026-09-25T02:00:00Z', status: 'CANCELLED' })!)).toBe(false);
    expect(normalizeAppointment({ id: '1', status: 'SCHEDULED' })).toBeNull();
  });

  it('requires an explicit source offset and preserves the Vietnam appointment instant', () => {
    expect(parseSourceInstant('2026-09-25T18:00:00')).toBeNull();
    expect(parseSourceInstant('2026-09-25 18:00:00')).toBeNull();
    expect(parseSourceInstant('2026-09-25T18:00:00+07:00')?.toISOString()).toBe('2026-09-25T11:00:00.000Z');
    expect(normalizeAppointment({ id: 'offsetless', appointmentTime: '2026-09-25T18:00:00', status: 'SCHEDULED' })).toBeNull();
    expect(normalizeAppointment({ id: 'offset', appointmentTime: '2026-09-25T18:00:00+07:00', status: 'SCHEDULED' })?.appointmentAt.toISOString()).toBe('2026-09-25T11:00:00.000Z');
  });

  it('accepts PETCLINIC DEFAULT_ALLOWED only for Zalo appointment reminders and lets explicit revoke win', () => {
    const base = { id: 'consent-1', appointmentTime: '2026-09-25T10:00:00Z', status: 'SCHEDULED' };
    expect(normalizeAppointment({ ...base, consent: { purpose: 'APPOINTMENT_REMINDER', channel: 'ZALO', status: 'DEFAULT_ALLOWED', eligible: true } })?.consentGranted).toBe(true);
    expect(normalizeAppointment({ ...base, messagingConsent: true, consent: { purpose: 'APPOINTMENT_REMINDER', channel: 'ZALO', status: 'REVOKED', eligible: false } })?.consentGranted).toBe(false);
    expect(normalizeAppointment({ ...base, consent: { purpose: 'MARKETING', channel: 'ZALO', status: 'DEFAULT_ALLOWED', eligible: true } })?.consentGranted).toBe(false);
    expect(normalizeAppointment({ ...base, consent: { purpose: 'APPOINTMENT_REMINDER', channel: 'SMS', status: 'DEFAULT_ALLOWED', eligible: true } })?.consentGranted).toBe(false);
  });

  it('locks requests to the configured HTTPS origin', () => {
    expect(safeApiUrl('https://api.mpets.vn', '/clinic-service/api/v1/clinic/appointments', { from: '2026-09-23' }).origin).toBe('https://api.mpets.vn');
    expect(() => safeApiUrl('https://api.mpets.vn', 'https://attacker.example/steal', {})).toThrow('PETCLINIC_API_ORIGIN_MISMATCH');
    expect(() => safeApiUrl('http://api.mpets.vn', '/appointments', {})).toThrow('PETCLINIC_API_REQUIRES_HTTPS');
  });
});
