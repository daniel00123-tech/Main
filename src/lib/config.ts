import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("file:./dev.db"),
  AUTH_SECRET: z.string().min(32).default("development-only-secret-change-me-32"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  AUTO_RELEASE_HOURS: z.coerce.number().positive().default(24),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
  PAYMENT_PROVIDER: z.enum(["mock", "stripe"]).default("mock"),
});

export const config = envSchema.parse(process.env);

export const marketplaceConfig = {
  customerFeeRate: 0.1,
  supplierFlatFeePence: 100,
  currency: "GBP",
  autoReleaseHours: config.AUTO_RELEASE_HOURS,
};

export const appConfig = {
  authSecret: config.AUTH_SECRET,
  sessionTtlHours: config.SESSION_TTL_HOURS,
  approvalWindowHours: config.AUTO_RELEASE_HOURS,
  appUrl: config.NEXT_PUBLIC_APP_URL,
  paymentProvider: config.PAYMENT_PROVIDER,
};
