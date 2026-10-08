import type { Request, Response } from "express";
import { healthStatus } from "../services/health.service.js";

export function getHealth(_request: Request, response: Response): void {
  response.json(healthStatus());
}
