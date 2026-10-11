import type { Request, Response, NextFunction } from "express";
import { PaystackWebhookError, processPaystackWebhook } from "../services/paystack-webhook.service.js";

export async function postPaystackWebhook(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  if (!Buffer.isBuffer(request.body)) {
    next(new PaystackWebhookError("INVALID_PAYLOAD", 400));
    return;
  }

  try {
    const result = await processPaystackWebhook(
      request.body,
      request.get("x-paystack-signature"),
    );

    if (result.outcome === "mismatch" || result.outcome === "terminal_conflict") {
      response.status(409).json({
        success: false,
        data: { received: true, processed: result.outcome === "terminal_conflict" },
        error: {
          code: result.outcome === "mismatch" ? result.reason : "TERMINAL_PAYMENT_CONFLICT",
          message: result.outcome === "mismatch"
            ? "Paystack transaction does not match the internal payment."
            : "Paystack success conflicts with a terminal payment state.",
        },
      });
      return;
    }

    response.status(200).json({
      success: true,
      data: {
        received: true,
        processed: result.outcome === "processed" ||
          (result.outcome === "duplicate" && result.processed),
        ...(result.outcome === "duplicate" ? { duplicate: true } : {}),
        ...(result.outcome === "unsupported" ? { unsupported: true } : {}),
        ...(result.outcome === "unknown_payment" ? { reason: "PAYMENT_NOT_FOUND" } : {}),
      },
    });
  } catch (error) {
    next(error);
  }
}
