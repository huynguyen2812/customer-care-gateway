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

export function normalizeAppointment(value: Record<string, any>): PetclinicAppointment | null {
  const id = text(value.id || value.appointmentId || value.code);
  const rawAt = value.appointmentTime || value.appointmentDateTime || value.scheduledAt || value.startTime;
  const appointmentAt = new Date(rawAt);
  const owner = value.owner || value.customer || value.petOwner || {};
  const pet = value.pet || {};
  const branch = value.branch || {};
  const service = value.service || value.appointmentService || {};
  if (!id || Number.isNaN(appointmentAt.getTime())) return null;
  return {
    id,
    appointmentAt,
    status: text(value.status).toUpperCase(),
    branchId: text(value.branchId || branch.id) || null,
    ownerName: text(value.ownerName || value.customerName || owner.name || owner.fullName),
    phone: text(value.phone || value.ownerPhone || value.customerPhone || owner.phone || owner.phoneNumber),
    petName: text(value.petName || pet.name),
    serviceName: text(value.serviceName || service.name),
    consentGranted: value.messagingConsent === true || value.zaloConsent === true || value.consentToContact === true,
    revision: text(value.revision),
  };
}

export function isReminderEligible(appointment: PetclinicAppointment): boolean {
  return ['SCHEDULED', 'CONFIRMED', 'DA_LEN_LICH', 'ĐÃ LÊN LỊCH'].includes(appointment.status);
}
