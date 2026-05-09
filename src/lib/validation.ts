import { z } from "zod";

export const serviceCategories = [
  "plumbing",
  "electrical",
  "hvac",
  "cleaning",
  "security",
  "general-maintenance"
] as const;

const moneySchema = z.coerce.number().positive().multipleOf(0.01);

export const customerRegistrationSchema = z.object({
  role: z.literal("CUSTOMER"),
  name: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  password: z.string().min(8),
  companyName: z.string().min(2),
  location: z.string().min(2)
});

export const supplierRegistrationSchema = z.object({
  role: z.literal("SUPPLIER"),
  businessName: z.string().min(2),
  contactName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
  password: z.string().min(8),
  location: z.string().min(2),
  services: z.array(z.enum(serviceCategories)).min(1),
  description: z.string().min(20),
  rate: moneySchema,
  rateType: z.enum(["HOURLY", "FIXED"]),
  availability: z.string().min(2)
});

export const registrationSchema = z.discriminatedUnion("role", [
  customerRegistrationSchema,
  supplierRegistrationSchema
]);

export const jobSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(20),
  category: z.enum(serviceCategories),
  location: z.string().min(2),
  budget: moneySchema,
  deadline: z.coerce.date(),
  type: z.enum(["BIDDING", "BROADCAST"]),
  autoAssign: z.coerce.boolean().default(false)
});

export const offerSchema = z.object({
  jobId: z.string().min(1),
  price: moneySchema,
  message: z.string().min(5)
});

export const completionSchema = z.object({
  jobId: z.string().min(1),
  notes: z.string().min(5),
  photoUrls: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean)
        : []
    )
});

export const addFundsSchema = z.object({
  amount: moneySchema
});

export const withdrawSchema = z.object({
  amount: moneySchema
});
