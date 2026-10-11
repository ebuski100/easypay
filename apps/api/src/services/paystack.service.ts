import { z } from "zod";
import { getPaystackSecretKey } from "../config/env.js";

const initializeTransactionUrl = "https://api.paystack.co/transaction/initialize";
const verifyTransactionUrl = "https://api.paystack.co/transaction/verify";

const checkoutUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.paystack.com";
  } catch {
    return false;
  }
}, "Expected a Paystack checkout URL");

const initializeResponseSchema = z.object({
  status: z.literal(true),
  data: z.object({
    authorization_url: checkoutUrlSchema,
    reference: z.string().min(1),
  }),
});

const verifyResponseSchema = z.object({
  status: z.literal(true),
  data: z.object({
    status: z.enum([
      "abandoned",
      "failed",
      "ongoing",
      "pending",
      "processing",
      "queued",
      "reversed",
      "success",
    ]),
    reference: z.string().min(1).optional(),
    amount: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
});

export type PaystackInitializationErrorCode =
  | "NOT_CONFIGURED"
  | "NETWORK_ERROR"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE";

export class PaystackError extends Error {
  constructor(
    readonly operation: "initialization" | "verification",
    readonly code: PaystackInitializationErrorCode,
    readonly providerStatus?: number,
  ) {
    super(`Paystack transaction ${operation} failed`);
    this.name = "PaystackError";
  }
}

export interface InitializePaystackTransactionInput {
  email: string;
  amount: number;
  currency: string;
  description?: string;
}

export interface PaystackInitializationResult {
  reference: string;
  authorizationUrl: string;
}

export type PaystackTransactionStatus = z.infer<typeof verifyResponseSchema>["data"]["status"];

export interface PaystackVerificationResult {
  status: PaystackTransactionStatus;
  reference?: string;
  amount: number;
  currency: string;
}

export const paystackClient = {
  async initializeTransaction(
    input: InitializePaystackTransactionInput,
  ): Promise<PaystackInitializationResult> {
    const secretKey = getPaystackSecretKey();
    if (!secretKey) {
      throw new PaystackError("initialization", "NOT_CONFIGURED");
    }

    const requestBody = {
      email: input.email,
      amount: String(input.amount),
      currency: input.currency,
      ...(input.description === undefined
        ? {}
        : { metadata: JSON.stringify({ description: input.description }) }),
    };

    let response: Response;
    try {
      response = await fetch(initializeTransactionUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secretKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PaystackError("initialization", "NETWORK_ERROR");
    }

    if (!response.ok) {
      throw new PaystackError("initialization", "PROVIDER_ERROR", response.status);
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new PaystackError("initialization", "INVALID_RESPONSE", response.status);
    }

    const parsed = initializeResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new PaystackError("initialization", "INVALID_RESPONSE", response.status);
    }

    return {
      reference: parsed.data.data.reference,
      authorizationUrl: parsed.data.data.authorization_url,
    };
  },

  async verifyTransaction(paystackReference: string): Promise<PaystackVerificationResult> {
    const secretKey = getPaystackSecretKey();
    if (!secretKey) {
      throw new PaystackError("verification", "NOT_CONFIGURED");
    }

    let response: Response;
    try {
      response = await fetch(
        `${verifyTransactionUrl}/${encodeURIComponent(paystackReference)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${secretKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new PaystackError("verification", "NETWORK_ERROR");
    }

    if (!response.ok) {
      throw new PaystackError("verification", "PROVIDER_ERROR", response.status);
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new PaystackError("verification", "INVALID_RESPONSE", response.status);
    }

    const parsed = verifyResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new PaystackError("verification", "INVALID_RESPONSE", response.status);
    }

    return parsed.data.data;
  },
};
