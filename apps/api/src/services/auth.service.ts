import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { Prisma } from "@prisma/client";
import { jwtVerify, SignJWT } from "jose";
import { accessTokenTtlSeconds, getAccessTokenSecret, refreshTokenTtlDays } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import type { LoginInput, RegisterInput } from "../validation/auth.schema.js";

const accessTokenKey = () => new TextEncoder().encode(getAccessTokenSecret());

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

async function createAccessToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + accessTokenTtlSeconds)
    .sign(accessTokenKey());
}

function refreshExpiry(): Date {
  return new Date(Date.now() + refreshTokenTtlDays * 24 * 60 * 60 * 1000);
}

export class AuthError extends Error {
  constructor(readonly code: "EMAIL_TAKEN" | "INVALID_CREDENTIALS" | "INVALID_REFRESH_TOKEN") {
    super("Authentication request could not be completed");
    this.name = "AuthError";
  }
}

export async function registerUser(input: RegisterInput) {
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  try {
    const user = await prisma.$transaction(async (transaction) => {
      const created = await transaction.user.create({
        data: { email: input.email, name: input.name, passwordHash },
        select: { id: true, email: true, name: true, createdAt: true },
      });
      const legacyCustomer = await transaction.customer.findFirst({
        where: { email: { equals: input.email, mode: "insensitive" } },
        select: { id: true, userId: true },
      });
      if (legacyCustomer?.userId) {
        throw new AuthError("EMAIL_TAKEN");
      }
      if (legacyCustomer) {
        await transaction.customer.update({ where: { id: legacyCustomer.id }, data: { userId: created.id } });
      } else {
        await transaction.customer.create({
          data: { email: input.email, name: input.name, userId: created.id },
        });
      }
      return created;
    }, { maxWait: 15_000, timeout: 30_000 });
    return { email: user.email, name: user.name, createdAt: user.createdAt };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AuthError("EMAIL_TAKEN");
    }
    throw error;
  }
}

async function issueSession(user: { id: string; email: string; name: string }) {
  const accessToken = await createAccessToken(user.id);
  const refreshToken = newRefreshToken();
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hashRefreshToken(refreshToken), expiresAt: refreshExpiry() },
  });
  return {
    accessToken,
    refreshToken,
    expiresIn: accessTokenTtlSeconds,
    user: { email: user.email, name: user.name },
  };
}

export async function loginUser(input: LoginInput) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const valid = user
    ? await argon2.verify(user.passwordHash, input.password)
    : (await argon2.hash(input.password, { type: argon2.argon2id }), false);
  if (!user || !valid) throw new AuthError("INVALID_CREDENTIALS");
  return issueSession(user);
}

export async function refreshSession(refreshToken: string) {
  const tokenHash = hashRefreshToken(refreshToken);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!record || record.revokedAt || record.expiresAt <= new Date()) {
    throw new AuthError("INVALID_REFRESH_TOKEN");
  }

  const replacement = newRefreshToken();
  const accessToken = await createAccessToken(record.userId);
  const replaced = await prisma.$transaction(async (transaction) => {
    const result = await transaction.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) return false;
    await transaction.refreshToken.create({
      data: {
        userId: record.userId,
        tokenHash: hashRefreshToken(replacement),
        expiresAt: refreshExpiry(),
      },
    });
    return true;
  }, { maxWait: 15_000, timeout: 30_000 });
  if (!replaced) throw new AuthError("INVALID_REFRESH_TOKEN");
  return {
    accessToken,
    refreshToken: replacement,
    expiresIn: accessTokenTtlSeconds,
  };
}

export async function revokeRefreshToken(userId: string, refreshToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function verifyAccessToken(token: string): Promise<string | undefined> {
  try {
    const { payload } = await jwtVerify(token, accessTokenKey(), { algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

export async function getAuthenticatedUser(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });
}
