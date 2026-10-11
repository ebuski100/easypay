import { Router } from "express";
import { getPaymentVerification, postPayment } from "../controllers/payment.controller.js";
import { requireAuthentication } from "../middleware/auth.middleware.js";

export const paymentRouter = Router();
paymentRouter.get("/:reference/verify", requireAuthentication, getPaymentVerification);
paymentRouter.post("/", requireAuthentication, postPayment);
