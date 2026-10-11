import "dotenv/config";

const port = Number(process.env.PORT ?? 4000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

export const env = { port };

export function getAccessTokenSecret(): string {
  const secret = process.env.JWT_ACCESS_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("JWT_ACCESS_SECRET must contain at least 32 bytes");
  }
  return secret;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const accessTokenTtlSeconds = positiveInteger("ACCESS_TOKEN_TTL_SECONDS", 900);
export const refreshTokenTtlDays = positiveInteger("REFRESH_TOKEN_TTL_DAYS", 30);

export function getPaystackSecretKey(): string | undefined {
  return process.env.PAYSTACK_SECRET_KEY?.trim() || undefined;
}
