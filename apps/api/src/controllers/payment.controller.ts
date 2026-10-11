import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { createPayment, verifyPayment } from "../services/payment.service.js";
import { createPaymentSchema } from "../validation/create-payment.schema.js";

export async function postPayment(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = createPaymentSchema.safeParse(request.body);
  if (!parsed.success) {
    next(parsed.error);
    return;
  }

  try {
    const { payment, customer, authorizationUrl } = await createPayment(parsed.data, request.authenticatedUser!.id);

    response.status(201).json({
      success: true,
      data: {
        payment: {
          id: payment.id,
          reference: payment.reference,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          description: payment.description,
          createdAt: payment.createdAt,
        },
        authorizationUrl,
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getPaymentVerification(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = z.string().trim().min(1).max(128).safeParse(request.params.reference);
  if (!parsed.success) {
    next(parsed.error);
    return;
  }

  try {
    const { payment, customer } = await verifyPayment(parsed.data, request.authenticatedUser!.id);
    response.status(200).json({
      success: true,
      data: {
        payment: {
          id: payment.id,
          reference: payment.reference,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          description: payment.description,
          createdAt: payment.createdAt,
        },
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
        },
      },
    });
  } catch (error) {
    next(error);
  }
}
