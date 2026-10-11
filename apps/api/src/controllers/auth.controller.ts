import type { NextFunction, Request, Response } from "express";
import { loginUser, refreshSession, registerUser, revokeRefreshToken } from "../services/auth.service.js";
import { loginSchema, refreshSchema, registerSchema } from "../validation/auth.schema.js";

export async function register(request: Request, response: Response, next: NextFunction): Promise<void> {
  const parsed = registerSchema.safeParse(request.body);
  if (!parsed.success) { next(parsed.error); return; }
  try {
    const user = await registerUser(parsed.data);
    response.status(201).json({ success: true, data: { user } });
  } catch (error) { next(error); }
}

export async function login(request: Request, response: Response, next: NextFunction): Promise<void> {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) { next(parsed.error); return; }
  try {
    response.status(200).json({ success: true, data: await loginUser(parsed.data) });
  } catch (error) { next(error); }
}

export async function refresh(request: Request, response: Response, next: NextFunction): Promise<void> {
  const parsed = refreshSchema.safeParse(request.body);
  if (!parsed.success) { next(parsed.error); return; }
  try {
    response.status(200).json({ success: true, data: await refreshSession(parsed.data.refreshToken) });
  } catch (error) { next(error); }
}

export async function logout(request: Request, response: Response, next: NextFunction): Promise<void> {
  const parsed = refreshSchema.safeParse(request.body);
  if (!parsed.success) { next(parsed.error); return; }
  try {
    await revokeRefreshToken(request.authenticatedUser!.id, parsed.data.refreshToken);
    response.status(204).end();
  } catch (error) { next(error); }
}

