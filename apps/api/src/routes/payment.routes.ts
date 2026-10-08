import { Router } from "express";
import { postPayment } from "../controllers/payment.controller.js";

export const paymentRouter = Router();
paymentRouter.post("/", postPayment);
