# Payment Platform

An npm workspace containing a Next.js frontend and a separate Express API. The frontend communicates with the backend over HTTP; backend logic lives in the API app.

## Requirements

- Node.js 20.9 or newer
- npm
- PostgreSQL
- A Paystack test secret for payment initialization in development

## Setup

From the repository root:

```sh
npm install
```

Copy `apps/web/.env.example` to `apps/web/.env.local` and `apps/api/.env.example` to `apps/api/.env`. Set `DATABASE_URL` and `PAYSTACK_SECRET_KEY`; replace the JWT placeholder with a random secret of at least 32 bytes (for example, generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`). Keep real environment files out of version control.

Apply migrations and generate Prisma Client from the API workspace:

```sh
npm run db:migrate --workspace=@payment-platform/api
npm run db:generate --workspace=@payment-platform/api
```

## Run in development

Run each app in a separate terminal from the repository root:

```sh
npm run dev:api
npm run dev:web
```

The API listens on `http://localhost:4000`; the frontend is served by Next.js at `http://localhost:3000`.

The API provides `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, and authenticated `POST /api/v1/auth/logout`. Login returns a short-lived bearer access token and a rotating refresh token. Send protected payment requests with `Authorization: Bearer <access-token>`. Payment creation and verification are scoped to the authenticated account. Paystack webhooks remain separate and use Paystack signature verification.

Logout revokes the refresh token. An already-issued stateless access token can remain valid until it expires. Login and registration do not yet have rate limiting or brute-force protection; add those before production deployment. Password reset, email verification, MFA, and signing-key rotation are outside this stage.

## Checks and production builds

```sh
npm run typecheck
npm run build:api
npm run build:web
```
