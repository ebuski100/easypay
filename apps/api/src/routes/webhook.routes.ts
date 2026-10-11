import { Router } from "express";
import { postPaystackWebhook } from "../controllers/webhook.controller.js";

export const webhookRouter = Router();
webhookRouter.post("/paystack", postPaystackWebhook);
