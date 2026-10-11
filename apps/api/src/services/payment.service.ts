import { randomUUID } from "node:crypto";
import { PaymentProvider, PaymentStatus } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import {
  isTerminalPaymentStatus,
  mapPaystackStatus,
  transitionSourceStatuses,
} from "../domain/payment-state.js";
import {
  PaystackError,
  paystackClient,
} from "./paystack.service.js";
import type { CreatePaymentInput } from "../validation/create-payment.schema.js";

export async function createPayment(input: CreatePaymentInput, userId: string) {
  const initialRecords = await prisma.$transaction(async (transaction) => {
    let customer = await transaction.customer.findUnique({
      where: { userId },
    });
    if (!customer || customer.email.toLowerCase() !== input.customer.email.toLowerCase()) {
      throw new PaymentVerificationError("PAYMENT_NOT_FOUND");
    }
    if (customer.phone === null && input.customer.phone !== undefined) {
      customer = await transaction.customer.update({
        where: { id: customer.id },
        data: { phone: input.customer.phone },
      });
    }

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

    const attempt = await transaction.paymentAttempt.create({
      data: {
        paymentId: payment.id,
        provider: PaymentProvider.PAYSTACK,
        status: PaymentStatus.PENDING,
        amount: payment.amount,
      },
    });

    return { payment, customer, attempt };
  }, { maxWait: 10_000, timeout: 15_000 });

  let providerResult;
  try {
    providerResult = await paystackClient.initializeTransaction({
      email: initialRecords.customer.email,
      amount: initialRecords.payment.amount,
      currency: initialRecords.payment.currency,
      ...(initialRecords.payment.description === null
        ? {}
        : { description: initialRecords.payment.description }),
    });
  } catch (error) {
    const isDefiniteRejection =
      error instanceof PaystackError &&
      (error.code === "NOT_CONFIGURED" ||
        (error.code === "PROVIDER_ERROR" &&
          error.providerStatus !== undefined &&
          error.providerStatus >= 400 &&
          error.providerStatus < 500 &&
          error.providerStatus !== 408));

    try {
      await prisma.$transaction(async (transaction) => {
        const failureStatus = isDefiniteRejection
          ? PaymentStatus.FAILED
          : PaymentStatus.PROCESSING;
        await transaction.paymentAttempt.update({
          where: { id: initialRecords.attempt.id },
          data: { status: failureStatus },
        });
        await transaction.payment.update({
          where: { id: initialRecords.payment.id },
          data: { status: failureStatus },
        });
      }, { maxWait: 10_000, timeout: 15_000 });
    } catch (persistenceError) {
      console.error("Could not record Paystack initialization result", {
        paymentId: initialRecords.payment.id,
        errorType: persistenceError instanceof Error ? persistenceError.name : "UnknownError",
      });
      throw persistenceError;
    }

    throw error;
  }

  try {
    const persisted = await prisma.$transaction(async (transaction) => {
      const payment = await transaction.payment.update({
        where: { id: initialRecords.payment.id },
        data: { paystackReference: providerResult.reference },
      });
      const attempt = await transaction.paymentAttempt.update({
        where: { id: initialRecords.attempt.id },
        data: { providerReference: providerResult.reference },
      });

      return { payment, attempt };
    }, { maxWait: 10_000, timeout: 15_000 });

    return {
      ...persisted,
      customer: initialRecords.customer,
      authorizationUrl: providerResult.authorizationUrl,
    };
  } catch (error) {
    console.error("Paystack initialized but its result could not be persisted", {
      paymentId: initialRecords.payment.id,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

export class PaymentVerificationError extends Error {
  constructor(
    readonly code:
      | "PAYMENT_NOT_FOUND"
      | "PAYSTACK_REFERENCE_MISSING"
      | "PAYMENT_ATTEMPT_NOT_FOUND"
      | "VERIFICATION_MISMATCH"
      | "TERMINAL_PAYMENT_CONFLICT"
      | "UNMAPPABLE_PROVIDER_STATUS",
  ) {
    super("Payment verification could not safely update the payment");
    this.name = "PaymentVerificationError";
  }
}

export async function verifyPayment(reference: string, userId: string) {
  const payment = await prisma.payment.findFirst({
    where: { reference, customer: { userId } },
    include: { customer: true },
  });
  if (!payment) {
    throw new PaymentVerificationError("PAYMENT_NOT_FOUND");
  }

  // A prior successful verification is authoritative; never let a later provider
  // response move a successful payment backwards.
  if (payment.status === PaymentStatus.SUCCEEDED) {
    return { payment, customer: payment.customer };
  }

  const paystackReference = payment.paystackReference;
  if (!paystackReference) {
    throw new PaymentVerificationError("PAYSTACK_REFERENCE_MISSING");
  }

  const attempt = await prisma.paymentAttempt.findFirst({
    where: {
      paymentId: payment.id,
      provider: PaymentProvider.PAYSTACK,
      providerReference: paystackReference,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!attempt) {
    throw new PaymentVerificationError("PAYMENT_ATTEMPT_NOT_FOUND");
  }

  const providerResult = await paystackClient.verifyTransaction(paystackReference);
  const mismatch =
    (providerResult.reference !== undefined && providerResult.reference !== paystackReference) ||
    providerResult.amount !== payment.amount ||
    providerResult.currency !== payment.currency;
  if (mismatch) {
    console.error("Paystack verification did not match payment", {
      paymentId: payment.id,
      referenceMatched:
        providerResult.reference === undefined || providerResult.reference === paystackReference,
      amountMatched: providerResult.amount === payment.amount,
      currencyMatched: providerResult.currency === payment.currency,
    });
    throw new PaymentVerificationError("VERIFICATION_MISMATCH");
  }

  const reportedStatus = mapPaystackStatus(providerResult.status);
  if (!reportedStatus) {
    throw new PaymentVerificationError("UNMAPPABLE_PROVIDER_STATUS");
  }
  if (isTerminalPaymentStatus(payment.status)) {
    if (reportedStatus === PaymentStatus.SUCCEEDED) {
      throw new PaymentVerificationError("TERMINAL_PAYMENT_CONFLICT");
    }
    return { payment, customer: payment.customer };
  }

  const updatedPayment = await prisma.$transaction(async (transaction) => {
    // The conditional update protects against a terminal transition committed by
    // a concurrent webhook or verification after the initial read above.
    const updateResult = await transaction.payment.updateMany({
      where: {
        id: payment.id,
        status: { in: transitionSourceStatuses(reportedStatus) },
      },
      data: { status: reportedStatus },
    });

    if (updateResult.count === 0) {
      const current = await transaction.payment.findUniqueOrThrow({ where: { id: payment.id } });
      if (isTerminalPaymentStatus(current.status)) {
        if (current.status !== PaymentStatus.SUCCEEDED && reportedStatus === PaymentStatus.SUCCEEDED) {
          throw new PaymentVerificationError("TERMINAL_PAYMENT_CONFLICT");
        }
        return current;
      }
      throw new Error("Payment state changed to a state that cannot accept this verification result");
    }

    await transaction.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: reportedStatus },
    });
    return transaction.payment.findUniqueOrThrow({ where: { id: payment.id } });
  }, { maxWait: 10_000, timeout: 15_000 });

  return { payment: updatedPayment, customer: payment.customer };
}
