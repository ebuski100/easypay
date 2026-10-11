import { createHmac, timingSafeEqual } from "node:crypto";
import { PaymentProvider, PaymentStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { getPaystackSecretKey } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import {
  isTerminalPaymentStatus,
  mapPaystackStatus,
  transitionSourceStatuses,
} from "../domain/payment-state.js";

const webhookEnvelopeSchema = z.object({
  event: z.string().trim().min(1).max(100),
  data: z.record(z.string(), z.unknown()),
}).passthrough();

const chargeSuccessSchema = z.object({
  event: z.literal("charge.success"),
  data: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.literal("success"),
    reference: z.string().trim().min(1).max(255),
    amount: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    customer: z.object({ email: z.string().email().optional() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

export class PaystackWebhookError extends Error {
  constructor(
    readonly code: "INVALID_SIGNATURE" | "INVALID_PAYLOAD" | "NOT_CONFIGURED",
    readonly statusCode: 400 | 401 | 503,
  ) {
    super("Paystack webhook request was rejected");
    this.name = "PaystackWebhookError";
  }
}

export type PaystackWebhookResult =
  | { outcome: "unsupported"; eventType: string }
  | { outcome: "duplicate"; processed: boolean }
  | { outcome: "processed"; paymentStatus: PaymentStatus }
  | { outcome: "unknown_payment" }
  | { outcome: "mismatch"; reason: "REFERENCE_MISMATCH" | "AMOUNT_MISMATCH" | "CURRENCY_MISMATCH" }
  | { outcome: "terminal_conflict"; paymentStatus: PaymentStatus };

function isValidSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[\da-f]{128}$/i.test(signature)) {
    return false;
  }

  const received = Buffer.from(signature, "hex");
  const expected = createHmac("sha512", secret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function parsePayload(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw new PaystackWebhookError("INVALID_PAYLOAD", 400);
  }
}

export async function processPaystackWebhook(
  rawBody: Buffer,
  signature: string | undefined,
): Promise<PaystackWebhookResult> {
  const secret = getPaystackSecretKey();
  if (!secret) {
    throw new PaystackWebhookError("NOT_CONFIGURED", 503);
  }
  if (!isValidSignature(rawBody, signature, secret)) {
    throw new PaystackWebhookError("INVALID_SIGNATURE", 401);
  }

  const parsedEnvelope = webhookEnvelopeSchema.safeParse(parsePayload(rawBody));
  if (!parsedEnvelope.success) {
    throw new PaystackWebhookError("INVALID_PAYLOAD", 400);
  }

  const { event: eventType } = parsedEnvelope.data;
  if (eventType !== "charge.success") {
    console.info("Unsupported Paystack webhook acknowledged", { eventType });
    return { outcome: "unsupported", eventType };
  }

  const parsedCharge = chargeSuccessSchema.safeParse(parsedEnvelope.data);
  if (!parsedCharge.success) {
    throw new PaystackWebhookError("INVALID_PAYLOAD", 400);
  }

  const event = parsedCharge.data;
  const nextStatus = mapPaystackStatus(event.data.status);
  if (!nextStatus) {
    throw new PaystackWebhookError("INVALID_PAYLOAD", 400);
  }
  // Paystack's charge payload has a stable numeric transaction ID, but no separate event ID.
  const eventId = `${event.event}:${event.data.id}`;
  console.info("Paystack webhook received", { eventType: event.event, eventId });

  try {
    const result = await prisma.$transaction(async (transaction) => {
      await transaction.webhookEvent.create({
        data: {
          provider: PaymentProvider.PAYSTACK,
          eventId,
          eventType: event.event,
          payload: event as Prisma.InputJsonValue,
        },
      });

      const attempt = await transaction.paymentAttempt.findFirst({
        where: {
          provider: PaymentProvider.PAYSTACK,
          providerReference: event.data.reference,
        },
        include: { payment: true },
      });

      if (!attempt) {
        console.warn("Paystack webhook has no matching payment attempt", { eventId });
        return { outcome: "unknown_payment" } as const;
      }

      const payment = attempt.payment;
      let mismatchReason: "REFERENCE_MISMATCH" | "AMOUNT_MISMATCH" | "CURRENCY_MISMATCH" | undefined;
      if (payment.paystackReference !== event.data.reference) {
        mismatchReason = "REFERENCE_MISMATCH";
      } else if (payment.amount !== event.data.amount || attempt.amount !== event.data.amount) {
        mismatchReason = "AMOUNT_MISMATCH";
      } else if (payment.currency !== event.data.currency) {
        mismatchReason = "CURRENCY_MISMATCH";
      }

      if (mismatchReason) {
        console.warn("Paystack webhook does not match internal payment", {
          eventId,
          paymentId: payment.id,
          mismatch: mismatchReason,
        });
        return { outcome: "mismatch", reason: mismatchReason } as const;
      }

      if (isTerminalPaymentStatus(payment.status)) {
        if (payment.status === PaymentStatus.SUCCEEDED) {
          if (attempt.status !== PaymentStatus.SUCCEEDED) {
            await transaction.paymentAttempt.update({
              where: { id: attempt.id },
              data: { status: PaymentStatus.SUCCEEDED },
            });
          }
          await transaction.webhookEvent.update({
            where: { provider_eventId: { provider: PaymentProvider.PAYSTACK, eventId } },
            data: { processed: true, processedAt: new Date() },
          });
          return { outcome: "processed", paymentStatus: PaymentStatus.SUCCEEDED } as const;
        }

        await transaction.webhookEvent.update({
          where: { provider_eventId: { provider: PaymentProvider.PAYSTACK, eventId } },
          data: { processed: true, processedAt: new Date() },
        });
        console.warn("Paystack success conflicts with terminal payment state", {
          eventId,
          paymentId: payment.id,
          paymentStatus: payment.status,
        });
        return { outcome: "terminal_conflict", paymentStatus: payment.status } as const;
      }

      const updateResult = await transaction.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: transitionSourceStatuses(nextStatus) },
        },
        data: { status: nextStatus },
      });

      if (updateResult.count === 0) {
        const current = await transaction.payment.findUniqueOrThrow({ where: { id: payment.id } });
        if (current.status === PaymentStatus.SUCCEEDED) {
          if (attempt.status !== PaymentStatus.SUCCEEDED) {
            await transaction.paymentAttempt.update({
              where: { id: attempt.id },
              data: { status: PaymentStatus.SUCCEEDED },
            });
          }
          await transaction.webhookEvent.update({
            where: { provider_eventId: { provider: PaymentProvider.PAYSTACK, eventId } },
            data: { processed: true, processedAt: new Date() },
          });
          return { outcome: "processed", paymentStatus: PaymentStatus.SUCCEEDED } as const;
        }

        if (isTerminalPaymentStatus(current.status)) {
          await transaction.webhookEvent.update({
            where: { provider_eventId: { provider: PaymentProvider.PAYSTACK, eventId } },
            data: { processed: true, processedAt: new Date() },
          });
          console.warn("Paystack success conflicts with terminal payment state", {
            eventId,
            paymentId: payment.id,
            paymentStatus: current.status,
          });
          return { outcome: "terminal_conflict", paymentStatus: current.status } as const;
        }

        throw new Error("Payment state changed to a state that cannot accept this webhook");
      }

      await transaction.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: nextStatus },
      });
      await transaction.webhookEvent.update({
        where: { provider_eventId: { provider: PaymentProvider.PAYSTACK, eventId } },
        data: { processed: true, processedAt: new Date() },
      });

      return { outcome: "processed", paymentStatus: nextStatus } as const;
    }, { maxWait: 10_000, timeout: 15_000 });

    if (result.outcome === "processed") {
      console.info("Paystack webhook processed", { eventId, paymentStatus: result.paymentStatus });
    }
    return result;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.webhookEvent.findUnique({
        where: { provider_eventId: { provider: PaymentProvider.PAYSTACK, eventId } },
      });
      if (existing) {
        console.info("Duplicate Paystack webhook acknowledged", { eventId, processed: existing.processed });
        return { outcome: "duplicate", processed: existing.processed };
      }
    }

    console.error("Paystack webhook processing failed", {
      eventId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}
