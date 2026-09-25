export type PetclinicAppointment = {
  id: string;
  appointmentAt: Date;
  status: string;
  branchId: string | null;
  ownerName: string;
  phone: string;
  petName: string;
  serviceName: string;
  consentGranted: boolean;
  revision: string;
};

const text = (value: unknown): string => value == null ? '' : String(value).trim();
const ISO_INSTANT_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

export function parseSourceInstant(value: unknown): Date | null {
  const raw = text(value);
  if (!ISO_INSTANT_WITH_OFFSET.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeAppointment(value: Record<string, any>): PetclinicAppointment | null {
  const id = text(value.id || value.appointmentId || value.code);
  const rawAt = value.appointmentTime || value.appointmentDateTime || value.scheduledAt || value.startTime;
  const appointmentAt = parseSourceInstant(rawAt);
  const owner = value.owner || value.customer || value.petOwner || {};
  const pet = value.pet || {};
  const branch = value.branch || {};
  const service = value.service || value.appointmentService || {};
  const consent = value.consent || {};
  const consentStatus = text(consent.status).toUpperCase();
  const consentPurpose = text(consent.purpose).toUpperCase();
  const consentChannel = text(consent.channel).toUpperCase();
  const isAppointmentZalo = (!consentPurpose || consentPurpose === 'APPOINTMENT_REMINDER')
    && (!consentChannel || consentChannel === 'ZALO');
  const explicitlyBlocked = ['REVOKED', 'WITHDRAWN', 'OPTED_OUT'].includes(consentStatus);
  const explicitlyAllowed = ['GRANTED', 'DEFAULT_ALLOWED'].includes(consentStatus);
  if (!id || !appointmentAt) return null;
  return {
    id,
    appointmentAt,
    status: text(value.status).toUpperCase(),
    branchId: text(value.branchId || branch.id) || null,
    ownerName: text(value.ownerName || value.customerName || owner.name || owner.fullName),
    phone: text(value.phone || value.ownerPhone || value.customerPhone || owner.phone || owner.phoneNumber),
    petName: text(value.petName || pet.name),
    serviceName: text(value.serviceName || service.name),
    // PETCLINIC defaults only appointment reminders over Zalo to allowed. An explicit
    // revocation always wins, including over stale legacy boolean fields.
    consentGranted: isAppointmentZalo && !explicitlyBlocked && (consent.eligible === true || explicitlyAllowed
      || value.messagingConsent === true || value.zaloConsent === true || value.consentToContact === true),
    revision: text(value.revision),
  };
}

export function isReminderEligible(appointment: PetclinicAppointment): boolean {
  return ['SCHEDULED', 'CONFIRMED', 'DA_LEN_LICH', 'ĐÃ LÊN LỊCH'].includes(appointment.status);
}
