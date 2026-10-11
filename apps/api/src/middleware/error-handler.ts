import { Prisma } from "@prisma/client";
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { PaystackError } from "../services/paystack.service.js";
import { PaystackWebhookError } from "../services/paystack-webhook.service.js";
import { PaymentVerificationError } from "../services/payment.service.js";
import { AuthError } from "../services/auth.service.js";

function isMalformedJson(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  );
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  if (isMalformedJson(error)) {
    response.status(400).json({
      success: false,
      error: { code: "MALFORMED_JSON", message: "Request body contains invalid JSON." },
    });
    return;
  }

  if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
    response.status(413).json({
      success: false,
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." },
    });
    return;
  }

  if (typeof error === "object" && error !== null && "type" in error && error.type === "encoding.unsupported") {
    response.status(415).json({
      success: false,
      error: { code: "UNSUPPORTED_CONTENT_ENCODING", message: "Request content encoding is not supported." },
    });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request body is invalid.",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof AuthError) {
    const conflict = error.code === "EMAIL_TAKEN";
    response.status(conflict ? 409 : 401).json({
      success: false,
      error: {
        code: conflict ? "EMAIL_TAKEN" : "INVALID_CREDENTIALS",
        message: conflict ? "An account with this email already exists." : "Authentication failed.",
      },
    });
    return;
  }

  if (error instanceof PaystackError) {
    const isConfigurationError = error.code === "NOT_CONFIGURED";
    const isVerification = error.operation === "verification";
    console.error(`Paystack ${isVerification ? "verification" : "initialization"} failed:`, {
      failureType: error.code,
      ...(error.providerStatus === undefined ? {} : { providerStatus: error.providerStatus }),
      method: request.method,
      path: request.path,
    });
    response.status(isConfigurationError ? 503 : 502).json({
      success: false,
      error: {
        code: isConfigurationError
          ? "PAYSTACK_NOT_CONFIGURED"
          : isVerification
            ? "PAYSTACK_VERIFICATION_FAILED"
            : "PAYSTACK_INITIALIZATION_FAILED",
        message: isConfigurationError
          ? "Payment provider is not configured."
          : isVerification
            ? "Unable to verify payment with the payment provider."
            : "Unable to initialize payment with the payment provider.",
      },
    });
    return;
  }

  if (error instanceof PaymentVerificationError) {
    const notFound = error.code === "PAYMENT_NOT_FOUND";
    const messages: Record<PaymentVerificationError["code"], string> = {
      PAYMENT_NOT_FOUND: "Payment not found.",
      PAYSTACK_REFERENCE_MISSING: "Payment cannot be verified because it has no provider reference.",
      PAYMENT_ATTEMPT_NOT_FOUND: "Payment cannot be verified because its provider attempt is missing.",
      VERIFICATION_MISMATCH: "Provider transaction does not match this payment.",
      TERMINAL_PAYMENT_CONFLICT: "Provider reports success for a payment in a terminal failure state.",
      UNMAPPABLE_PROVIDER_STATUS: "Provider transaction status cannot be mapped safely.",
    };
    if (!notFound) {
      console.error("Payment verification rejected safely:", {
        code: error.code,
        method: request.method,
        path: request.path,
      });
    }
    response.status(notFound ? 404 : 409).json({
      success: false,
      error: { code: error.code, message: messages[error.code] },
    });
    return;
  }

  if (error instanceof PaystackWebhookError) {
    if (error.code !== "INVALID_SIGNATURE") {
      console.error("Paystack webhook request rejected", {
        code: error.code,
        method: request.method,
        path: request.path,
      });
    }
    const messages: Record<PaystackWebhookError["code"], string> = {
      INVALID_SIGNATURE: "Webhook signature is invalid.",
      INVALID_PAYLOAD: "Webhook payload is invalid.",
      NOT_CONFIGURED: "Payment provider is not configured.",
    };
    response.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: messages[error.code] },
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    response.status(409).json({
      success: false,
      error: { code: "CONFLICT", message: "A record with these details already exists." },
    });
    return;
  }

  console.error("Unhandled API error:", {
    name: error instanceof Error ? error.name : "UnknownError",
    ...(error instanceof Prisma.PrismaClientKnownRequestError ? { prismaCode: error.code } : {}),
    method: request.method,
    path: request.path,
  });
  response.status(500).json({
    success: false,
    error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred." },
  });
};
