# Payment Platform

An npm workspace containing a Next.js frontend and a separate Express API. The frontend communicates with the backend over HTTP; backend logic lives in the API app.

## Requirements

- Node.js 20.9 or newer
- npm
- PostgreSQL (for future database work; no database models or connection are used yet)

## Setup

From the repository root:

```sh
npm install
```

Copy `apps/web/.env.example` to `apps/web/.env.local` and `apps/api/.env.example` to `apps/api/.env`. Adjust values for your environment. The API currently does not connect to PostgreSQL; `DATABASE_URL` is included as the planned Prisma connection setting.

## Run in development

Run each app in a separate terminal from the repository root:

```sh
npm run dev:api
npm run dev:web
```

The API listens on `http://localhost:4000` and responds to `GET /health`. The frontend is served by Next.js at `http://localhost:3000`.

## Checks and production builds

```sh
npm run typecheck
npm run build:api
npm run build:web
```
