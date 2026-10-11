import { PaymentStatus } from "@prisma/client";

const activeStatuses = [PaymentStatus.PENDING, PaymentStatus.PROCESSING] as const;
const activeTransitions: readonly PaymentStatus[] = [
  PaymentStatus.PROCESSING,
  PaymentStatus.SUCCEEDED,
  PaymentStatus.FAILED,
];

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return !activeStatuses.includes(status as (typeof activeStatuses)[number]);
}

export function canTransitionPaymentStatus(
  current: PaymentStatus,
  next: PaymentStatus,
): boolean {
  if (current === PaymentStatus.PENDING) {
    return activeTransitions.includes(next);
  }

  if (current === PaymentStatus.PROCESSING) {
    return activeTransitions.includes(next);
  }

  return false;
}

export function transitionSourceStatuses(next: PaymentStatus): PaymentStatus[] {
  return activeStatuses.filter((current) => canTransitionPaymentStatus(current, next));
}

export function mapPaystackStatus(status: string): PaymentStatus | undefined {
  switch (status) {
    case "success":
      return PaymentStatus.SUCCEEDED;
    case "failed":
    case "abandoned":
      return PaymentStatus.FAILED;
    case "pending":
    case "processing":
    case "ongoing":
    case "queued":
      return PaymentStatus.PROCESSING;
    case "reversed":
    default:
      return undefined;
  }
}
