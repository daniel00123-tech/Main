export type Role = "ADMIN" | "CUSTOMER" | "SUPPLIER";

export const USER_ROLES = ["ADMIN", "CUSTOMER", "SUPPLIER"] as const;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && USER_ROLES.includes(value as Role);
}
export const JOB_CATEGORIES = ["plumbing", "electrical", "cleaning", "hvac", "security", "general"] as const;
export const RATE_TYPES = ["hourly", "fixed"] as const;

export const Roles = {
  ADMIN: "ADMIN",
  CUSTOMER: "CUSTOMER",
  SUPPLIER: "SUPPLIER",
} as const;

export const SupplierStatuses = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
} as const;

export const JobStatuses = {
  OPEN: "OPEN",
  ASSIGNED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  CLOSED: "CLOSED",
  CANCELLED: "CANCELLED",
  DISPUTED: "DISPUTED",
} as const;

export const JobTypes = {
  BIDDING: "BIDDING",
  BROADCAST: "BROADCAST",
} as const;

export const OfferStatuses = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
} as const;

export const TransactionTypes = {
  CUSTOMER_FUNDING: "CUSTOMER_FUNDING",
  JOB_RESERVATION: "JOB_RESERVATION",
  JOB_RELEASE: "JOB_RELEASE",
  JOB_REFUND: "JOB_REFUND",
  SUPPLIER_WITHDRAWAL: "SUPPLIER_WITHDRAWAL",
  PLATFORM_FEE: "PLATFORM_FEE",
} as const;

export const TransactionStatuses = {
  PENDING: "PENDING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;

export const WalletTransactionTypes = {
  CREDIT: "CREDIT",
  DEBIT: "DEBIT",
  HOLD: "HOLD",
  RELEASE: "RELEASE",
  WITHDRAWAL: "WITHDRAWAL",
  FEE: "FEE",
} as const;

export const NotificationTypes = {
  JOB_POSTED: "JOB_POSTED",
  JOB_MATCHED: "JOB_MATCHED",
  OFFER_RECEIVED: "OFFER_RECEIVED",
  JOB_ASSIGNED: "JOB_ASSIGNED",
  JOB_COMPLETED: "JOB_COMPLETED",
  PAYMENT_RELEASED: "PAYMENT_RELEASED",
  SUPPLIER_APPROVED: "SUPPLIER_APPROVED",
  SUPPLIER_REJECTED: "SUPPLIER_REJECTED",
} as const;

export const ROLE = Roles;
export const SUPPLIER_STATUS = SupplierStatuses;
export const JOB_STATUS = JobStatuses;
export const JOB_TYPE = JobTypes;
export const OFFER_STATUS = OfferStatuses;
export const TRANSACTION_TYPE = TransactionTypes;
export const TRANSACTION_STATUS = TransactionStatuses;
export const WALLET_TRANSACTION_TYPE = WalletTransactionTypes;
export const NOTIFICATION_TYPE = NotificationTypes;

export function parseStringArray(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export type SupplierStatus = (typeof SupplierStatuses)[keyof typeof SupplierStatuses];
export type JobStatus = (typeof JobStatuses)[keyof typeof JobStatuses];
export type JobType = (typeof JobTypes)[keyof typeof JobTypes];
export type OfferStatus = (typeof OfferStatuses)[keyof typeof OfferStatuses];
export type TransactionType = (typeof TransactionTypes)[keyof typeof TransactionTypes];
export type TransactionStatus = (typeof TransactionStatuses)[keyof typeof TransactionStatuses];
export type WalletTransactionType = (typeof WalletTransactionTypes)[keyof typeof WalletTransactionTypes];
export type NotificationType = (typeof NotificationTypes)[keyof typeof NotificationTypes];

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

export type Session = {
  user: SessionUser;
};

export type FeeBreakdown = {
  jobAmount: number;
  customerFee: number;
  supplierFee: number;
  customerTotal: number;
  supplierReceives: number;
  platformFeeTotal: number;
};
