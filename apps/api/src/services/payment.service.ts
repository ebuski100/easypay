import { randomUUID } from "node:crypto";
import { PaymentStatus } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import type { CreatePaymentInput } from "../validation/create-payment.schema.js";

export async function createPayment(input: CreatePaymentInput) {
  return prisma.$transaction(async (transaction) => {
    const customer = await transaction.customer.upsert({
      where: { email: input.customer.email },
      create: input.customer,
      update: {},
    });

    const payment = await transaction.payment.create({
      data: {
        reference: `pay_${randomUUID()}`,
        customerId: customer.id,
        amount: input.amount,
        currency: input.currency,
        status: PaymentStatus.PENDING,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });

    return { payment, customer };
  });
}
