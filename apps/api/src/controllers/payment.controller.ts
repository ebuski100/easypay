import type { Request, Response, NextFunction } from "express";
import { createPayment } from "../services/payment.service.js";
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
    const { payment, customer } = await createPayment(parsed.data);

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
