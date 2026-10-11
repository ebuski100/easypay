import express from "express";
import { healthRouter } from "./routes/health.routes.js";
import { paymentRouter } from "./routes/payment.routes.js";
import { webhookRouter } from "./routes/webhook.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { errorHandler } from "./middleware/error-handler.js";

export const app = express();

app.use(
  "/api/v1/webhooks/paystack",
  express.raw({ type: "application/json", limit: "1mb", inflate: false }),
);
app.use(express.json());
app.use("/health", healthRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/payments", paymentRouter);
app.use("/api/v1/webhooks", webhookRouter);
app.use((_request, response) => {
  response.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: "Resource not found." },
  });
});
app.use(errorHandler);
