import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("file:./dev.db"),
  NEXTAUTH_SECRET: z.string().default("development-secret-change-me"),
  NEXTAUTH_URL: z.string().default("http://localhost:3000"),
  PAYMENT_PROVIDER: z.enum(["mock", "stripe"]).default("mock"),
  JOB_AUTO_RELEASE_HOURS: z.coerce.number().positive().default(24)
});

export const env = envSchema.parse(process.env);

export const marketplaceConfig = {
  customerFeeRate: 0.1,
  supplierFlatFee: 1,
  currency: "GBP",
  autoReleaseHours: env.JOB_AUTO_RELEASE_HOURS
} as const;
