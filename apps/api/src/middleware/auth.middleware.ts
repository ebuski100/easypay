import type { NextFunction, Request, Response } from "express";
import { getAuthenticatedUser, verifyAccessToken } from "../services/auth.service.js";

declare global {
  namespace Express {
    interface Request {
      authenticatedUser?: { id: string; email: string; name: string };
    }
  }
}

export async function requireAuthentication(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const [scheme, token, extra] = (request.get("authorization") ?? "").split(" ");
  if (scheme !== "Bearer" || !token || extra) {
    response.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Authentication is required." } });
    return;
  }
  const userId = await verifyAccessToken(token);
  if (!userId) {
    response.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Authentication is required." } });
    return;
  }
  try {
    const user = await getAuthenticatedUser(userId);
    if (!user) {
      response.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Authentication is required." } });
      return;
    }
    request.authenticatedUser = user;
    next();
  } catch (error) {
    next(error);
  }
}
