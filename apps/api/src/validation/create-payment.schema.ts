import { z } from "zod";

const customerSchema = z.strictObject({
  name: z.string().trim().min(1),
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  phone: z.string().trim().min(1).optional(),
});

export const createPaymentSchema = z.strictObject({
  customer: customerSchema,
  amount: z.number().int().positive().max(2_147_483_647),
  currency: z.string().regex(/^[A-Z]{3}$/),
  description: z.string().optional(),
});

export type CreatePaymentInput = z.output<typeof createPaymentSchema>;
