import { z } from "zod";
import { JOB_CATEGORIES, RATE_TYPES, USER_ROLES } from "./types";

const phoneSchema = z.string().min(7).max(40);
const passwordSchema = z.string().min(8, "Password must be at least 8 characters");

export const loginSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1)
});

export const registerSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("CUSTOMER"),
    name: z.string().min(2),
    email: z.string().email().transform((value) => value.toLowerCase()),
    password: passwordSchema,
    phone: phoneSchema,
    companyName: z.string().min(2),
    location: z.string().min(2)
  }),
  z.object({
    role: z.literal("SUPPLIER"),
    name: z.string().min(2),
    businessName: z.string().min(2),
    contactName: z.string().min(2),
    email: z.string().email().transform((value) => value.toLowerCase()),
    password: passwordSchema,
    phone: phoneSchema,
    location: z.string().min(2),
    services: z.array(z.enum(JOB_CATEGORIES)).min(1),
    description: z.string().min(20),
    rateType: z.enum(RATE_TYPES),
    rateAmount: z.coerce.number().int().positive(),
    availability: z.string().min(2)
  })
]);

export const adminCreateSchema = z.object({
  role: z.enum(USER_ROLES),
  name: z.string().min(2),
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: passwordSchema
});

export const createJobSchema = z.object({
  title: z.string().min(4),
  description: z.string().min(20),
  category: z.enum(JOB_CATEGORIES),
  location: z.string().min(2),
  budget: z.coerce.number().int().positive(),
  deadline: z.coerce.date().refine((value) => value.getTime() > Date.now(), {
    message: "Deadline must be in the future"
  }),
  jobType: z.enum(["BIDDING", "BROADCAST"]),
  firstSupplierCanAccept: z.coerce.boolean().default(false)
});

export const createOfferSchema = z.object({
  price: z.coerce.number().int().positive(),
  message: z.string().min(5).max(1000)
});

export const completeJobSchema = z.object({
  notes: z.string().min(5),
  photoUrls: z.array(z.string().url()).default([])
});

export const addFundsSchema = z.object({
  amount: z.coerce.number().int().positive()
});

export const supplierDecisionSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"])
});

export const withdrawSchema = z.object({
  amount: z.coerce.number().int().positive()
});

export const customerRegistrationSchema = registerSchema.options[0];
export const supplierRegistrationSchema = registerSchema.options[1];
export const jobCreateSchema = createJobSchema;
export const offerSchema = createOfferSchema;
export const walletFundingSchema = addFundsSchema;
export const supplierApprovalSchema = supplierDecisionSchema;
