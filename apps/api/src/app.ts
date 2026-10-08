import express from "express";
import { healthRouter } from "./routes/health.routes.js";
import { paymentRouter } from "./routes/payment.routes.js";
import { errorHandler } from "./middleware/error-handler.js";

export const app = express();

app.use(express.json());
app.use("/health", healthRouter);
app.use("/api/v1/payments", paymentRouter);
app.use((_request, response) => {
  response.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: "Resource not found." },
  });
});
app.use(errorHandler);
