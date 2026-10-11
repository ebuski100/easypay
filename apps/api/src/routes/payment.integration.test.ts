import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SignJWT } from "jose";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";

const customerEmail = `stage3-${randomUUID()}@example.com`;
const unconfiguredCustomerEmail = `stage4-unconfigured-${randomUUID()}@example.com`;
const failureCustomerEmail = `stage4-failure-${randomUUID()}@example.com`;
const invalidResponseCustomerEmail = `stage4-invalid-${randomUUID()}@example.com`;
const networkFailureCustomerEmail = `stage4-network-${randomUUID()}@example.com`;
const verificationCustomerEmails: string[] = [];
const webhookCustomerEmails: string[] = [];
const webhookEventIds: string[] = [];
const authEmails = new Set<string>();
const authTokens = new Map<string, string>();
const paymentOwners = new Map<string, string>();
let server: Server;
let baseUrl: string;
const nativeFetch = globalThis.fetch;
const fakePaystackSecret = "sk_test_mock_secret_for_tests";
const fakeJwtSecret = "test_only_jwt_secret_with_at_least_32_bytes";
let originalPaystackSecret: string | undefined;
let originalJwtSecret: string | undefined;
let providerFailureMode:
  | "success"
  | "http-error"
  | "server-error"
  | "invalid-response"
  | "network-error" = "success";
const providerRequests: Array<{
  authorization: string | null;
  body: Record<string, unknown>;
  reference: string;
  authorizationUrl: string;
}> = [];
const verificationRequests: Array<{ url: string; authorization: string | null }> = [];
let verificationResponseBody: unknown;
let verificationHttpStatus = 200;
let nextWebhookTransactionId = Math.floor(Math.random() * 1_000_000_000_000);
let nextVerificationBarrier: { signalStarted: () => void; wait: Promise<void> } | undefined;

before(async () => {
  originalPaystackSecret = process.env.PAYSTACK_SECRET_KEY;
  originalJwtSecret = process.env.JWT_ACCESS_SECRET;
  process.env.PAYSTACK_SECRET_KEY = fakePaystackSecret;
  process.env.JWT_ACCESS_SECRET = fakeJwtSecret;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.paystack.co/transaction/verify/")) {
      verificationRequests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      const body = verificationResponseBody ?? {
          status: true,
          data: {
            status: "success",
            reference: decodeURIComponent(url.split("/").at(-1) ?? ""),
            amount: 500_000,
            currency: "NGN",
            raw_secret: fakePaystackSecret,
          },
        };
      const status = verificationHttpStatus;
      const barrier = nextVerificationBarrier;
      if (barrier) {
        nextVerificationBarrier = undefined;
        barrier.signalStarted();
        await barrier.wait;
      }
      return Response.json(body, { status });
    }
    if (url !== "https://api.paystack.co/transaction/initialize") {
      return nativeFetch(input, init);
    }

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (providerFailureMode === "http-error") {
      providerFailureMode = "success";
      return Response.json({ status: false, message: "PRIVATE_PROVIDER_ERROR" }, { status: 400 });
    }

    if (providerFailureMode === "server-error") {
      providerFailureMode = "success";
      return Response.json({ status: false, message: "PRIVATE_PROVIDER_ERROR" }, { status: 500 });
    }

    if (providerFailureMode === "invalid-response") {
      providerFailureMode = "success";
      return Response.json({ status: true, data: { reference: "missing-authorization-url" } });
    }

    if (providerFailureMode === "network-error") {
      providerFailureMode = "success";
      throw new TypeError("mock network failure");
    }

    const reference = `PS_${randomUUID().replaceAll("-", "")}`;
    const authorizationUrl = `https://checkout.paystack.com/${randomUUID()}`;
    providerRequests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      body,
      reference,
      authorizationUrl,
    });
    return Response.json({
      status: true,
      message: "Authorization URL created",
      data: { authorization_url: authorizationUrl, reference },
    });
  };

  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  globalThis.fetch = nativeFetch;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  const emailsToClean = [...new Set([
    ...authEmails,
    customerEmail,
    unconfiguredCustomerEmail,
    failureCustomerEmail,
    invalidResponseCustomerEmail,
    networkFailureCustomerEmail,
    ...verificationCustomerEmails,
    ...webhookCustomerEmails,
  ])];
  await prisma.refreshToken.deleteMany({ where: { user: { email: { in: [...authEmails] } } } });

  await prisma.paymentAttempt.deleteMany({ where: { payment: { customer: { email: { in: emailsToClean } } } } });
  await prisma.payment.deleteMany({ where: { customer: { email: { in: emailsToClean } } } });
  await prisma.customer.deleteMany({ where: { email: { in: emailsToClean } } });
  await prisma.user.deleteMany({ where: { email: { in: [...authEmails] } } });
  if (webhookEventIds.length > 0) {
    await prisma.webhookEvent.deleteMany({
      where: { provider: "PAYSTACK", eventId: { in: webhookEventIds } },
    });
  }
  await prisma.$disconnect();
  if (originalPaystackSecret === undefined) {
    delete process.env.PAYSTACK_SECRET_KEY;
  } else {
    process.env.PAYSTACK_SECRET_KEY = originalPaystackSecret;
  }
  if (originalJwtSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
  else process.env.JWT_ACCESS_SECRET = originalJwtSecret;
});

async function tokenFor(email: string): Promise<string> {
  const normalizedEmail = email.toLowerCase();
  const existing = authTokens.get(normalizedEmail);
  if (existing) return existing;
  authEmails.add(normalizedEmail);
  const password = "Integration-test-password-123!";
  const registrationRequest = () => fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Stage Three Test", email: normalizedEmail, password }),
  });
  let registration = await registrationRequest();
  if (registration.status >= 500) registration = await registrationRequest();
  assert.ok(registration.status === 201 || registration.status === 409);
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: normalizedEmail, password }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  authTokens.set(normalizedEmail, result.data.accessToken as string);
  return result.data.accessToken as string;
}

async function postPayment(body: unknown): Promise<Response> {
  const bodyCustomer = typeof body === "object" && body !== null && "customer" in body
    ? (body as { customer?: { email?: unknown } }).customer
    : undefined;
  const email = typeof bodyCustomer?.email === "string" && bodyCustomer.email.includes("@")
    ? bodyCustomer.email
    : customerEmail;
  const token = await tokenFor(email);
  return fetch(`${baseUrl}/api/v1/payments`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function seedPayment(options: {
  status?: "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "REFUNDED";
  paystackReference?: string | null;
  amount?: number;
  currency?: string;
  attemptProviderReference?: string;
} = {}) {
  const email = customerEmail;
  verificationCustomerEmails.push(email);
  await tokenFor(email);
  const customer = await prisma.customer.findUniqueOrThrow({ where: { email } });
  const providerReference = options.paystackReference === undefined
    ? `PS_${randomUUID().replaceAll("-", "")}`
    : options.paystackReference;
  const payment = await prisma.payment.create({
    data: {
      reference: `pay_${randomUUID()}`,
      customerId: customer.id,
      amount: options.amount ?? 500_000,
      currency: options.currency ?? "NGN",
      status: options.status ?? "PENDING",
      paystackReference: providerReference,
    },
  });
  const attempt = await prisma.paymentAttempt.create({
    data: {
      paymentId: payment.id,
      provider: "PAYSTACK",
      providerReference: options.attemptProviderReference ?? providerReference ?? undefined,
      amount: payment.amount,
      status: options.status ?? "PENDING",
    },
  });
  paymentOwners.set(payment.reference, email);
  return { email, customer, payment, attempt, providerReference };
}

function chargeSuccessEvent(
  fixture: Awaited<ReturnType<typeof seedPayment>>,
  values: { id?: number; reference?: string; amount?: number; currency?: string } = {},
) {
  const id = values.id ?? ++nextWebhookTransactionId;
  const event = {
    event: "charge.success",
    data: {
      id,
      domain: "test",
      status: "success",
      reference: values.reference ?? fixture.providerReference,
      amount: values.amount ?? fixture.payment.amount,
      currency: values.currency ?? fixture.payment.currency,
      customer: { email: fixture.email },
    },
  };
  webhookEventIds.push(`charge.success:${id}`);
  return event;
}

async function postPaystackWebhook(
  payload: unknown,
  options: { rawBody?: string; signature?: string | null } = {},
): Promise<Response> {
  const rawBody = options.rawBody ?? JSON.stringify(payload);
  const signature = options.signature === undefined
    ? createHmac("sha512", fakePaystackSecret).update(rawBody).digest("hex")
    : options.signature;
  return fetch(`${baseUrl}/api/v1/webhooks/paystack`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === null ? {} : { "x-paystack-signature": signature }),
    },
    body: rawBody,
  });
}

async function getVerification(reference: string): Promise<Response> {
  const email = paymentOwners.get(reference) ?? customerEmail;
  const token = await tokenFor(email);
  return fetch(`${baseUrl}/api/v1/payments/${encodeURIComponent(reference)}/verify`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function setVerificationResponse(
  status: string,
  values: { reference?: string; amount?: number; currency?: string } = {},
) {
  verificationHttpStatus = 200;
  verificationResponseBody = {
    status: true,
    message: "Private provider response detail",
    data: {
      status,
      reference: values.reference,
      amount: values.amount ?? 500_000,
      currency: values.currency ?? "NGN",
      raw_secret: fakePaystackSecret,
    },
  };
}

function holdNextVerificationResponse() {
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  nextVerificationBarrier = { signalStarted, wait };
  return { started, release };
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    customer: { name: "Stage Three Test", email: customerEmail, phone: "08012345678" },
    amount: 500_000,
    currency: "NGN",
    description: "Payment for order",
    ...overrides,
  };
}

test("payment API creates and validates payments", { timeout: 420_000 }, async (context) => {
  await context.test("health endpoint still works", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  await context.test("initializes Paystack and creates a pending payment, attempt, and customer", async () => {
    const response = await postPayment(validRequest());
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.success, true);
    assert.equal(result.data.payment.status, "PENDING");
    assert.match(result.data.payment.reference, /^pay_[0-9a-f-]{36}$/);
    assert.equal(result.data.payment.amount, 500_000);
    assert.equal(result.data.customer.email, customerEmail);
    assert.equal(result.data.authorizationUrl, providerRequests[0]?.authorizationUrl);
    assert.equal(JSON.stringify(result).includes(fakePaystackSecret), false);
    assert.equal(providerRequests[0]?.authorization, `Bearer ${fakePaystackSecret}`);
    assert.equal(providerRequests[0]?.body.email, customerEmail);
    assert.equal(providerRequests[0]?.body.amount, "500000");
    assert.equal(providerRequests[0]?.body.currency, "NGN");
    assert.deepEqual(JSON.parse(String(providerRequests[0]?.body.metadata)), {
      description: "Payment for order",
    });

    const [customer, payment] = await Promise.all([
      prisma.customer.findUnique({ where: { email: customerEmail } }),
      prisma.payment.findUnique({ where: { reference: result.data.payment.reference } }),
    ]);
    assert.ok(customer);
    assert.equal(payment?.customerId, customer.id);
    assert.equal(payment?.status, "PENDING");
    assert.ok(payment?.paystackReference);
    assert.equal(payment.paystackReference, providerRequests[0]?.reference);
    assert.equal("customerId" in result.data.payment, false);
    const attempts = payment
      ? await prisma.paymentAttempt.findMany({ where: { paymentId: payment.id } })
      : [];
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.provider, "PAYSTACK");
    assert.equal(attempts[0]?.amount, 500_000);
    assert.equal(attempts[0]?.status, "PENDING");
    assert.equal(attempts[0]?.providerReference, payment?.paystackReference);
  });

  await context.test("reuses an existing customer without overwriting it", async () => {
    const response = await postPayment(
      validRequest({ customer: { name: "Changed Name", email: customerEmail, phone: "09999999999" } }),
    );
    const result = await response.json();
    const customer = await prisma.customer.findUnique({ where: { email: customerEmail } });

    assert.equal(response.status, 201);
    assert.equal(result.data.customer.id, customer?.id);
    assert.equal(result.data.customer.name, "Stage Three Test");
    assert.equal(customer?.phone, "08012345678");
  });

  await context.test("handles concurrent requests for the same customer email", async () => {
    const responses = await Promise.all([
      postPayment(validRequest()),
      postPayment(validRequest()),
    ]);
    const results = await Promise.all(responses.map((response) => response.json()));

    assert.ok(responses.every((response) => response.status === 201));
    assert.equal(results[0].data.customer.id, results[1].data.customer.id);
    assert.notEqual(results[0].data.payment.reference, results[1].data.payment.reference);
    assert.equal(await prisma.customer.count({ where: { email: customerEmail } }), 1);
  });

  await context.test("returns a safe configuration error when the secret key is missing", async () => {
    const requestCount = providerRequests.length;
    delete process.env.PAYSTACK_SECRET_KEY;

    let response: Response;
    try {
      response = await postPayment(
        validRequest({
          customer: { name: "Unconfigured Provider Test", email: unconfiguredCustomerEmail },
        }),
      );
    } finally {
      process.env.PAYSTACK_SECRET_KEY = fakePaystackSecret;
    }

    const result = await response!.json();
    assert.equal(response!.status, 503);
    assert.equal(result.error.code, "PAYSTACK_NOT_CONFIGURED");
    assert.equal(JSON.stringify(result).includes(fakePaystackSecret), false);
    assert.equal(providerRequests.length, requestCount);
    const payment = await prisma.payment.findFirst({
      where: { customer: { email: unconfiguredCustomerEmail } },
    });
    assert.equal(payment?.status, "FAILED");
  });

  await context.test("marks payment and attempt failed when Paystack rejects initialization", async () => {
    providerFailureMode = "http-error";
    const response = await postPayment(
      validRequest({
        customer: { name: "Failed Initialization Test", email: failureCustomerEmail },
      }),
    );
    const result = await response.json();

    assert.equal(response.status, 502);
    assert.equal(result.success, false);
    assert.equal(result.error.code, "PAYSTACK_INITIALIZATION_FAILED");
    assert.equal(JSON.stringify(result).includes(fakePaystackSecret), false);
    assert.equal(JSON.stringify(result).includes("PRIVATE_PROVIDER_ERROR"), false);

    const payment = await prisma.payment.findFirst({
      where: { customer: { email: failureCustomerEmail } },
    });
    assert.ok(payment);
    assert.equal(payment.status, "FAILED");
    assert.equal(payment.paystackReference, null);
    const attempt = await prisma.paymentAttempt.findFirst({ where: { paymentId: payment.id } });
    assert.equal(attempt?.status, "FAILED");
    assert.equal(attempt?.providerReference, null);
  });

  await context.test("rejects an incomplete successful Paystack response", async () => {
    providerFailureMode = "invalid-response";
    const response = await postPayment(
      validRequest({
        customer: { name: "Invalid Provider Response Test", email: invalidResponseCustomerEmail },
      }),
    );
    const result = await response.json();

    assert.equal(response.status, 502);
    assert.equal(result.error.code, "PAYSTACK_INITIALIZATION_FAILED");
    const payment = await prisma.payment.findFirst({
      where: { customer: { email: invalidResponseCustomerEmail } },
    });
    assert.equal(payment?.status, "PROCESSING");
    assert.equal(payment?.paystackReference, null);
    const attempt = payment
      ? await prisma.paymentAttempt.findFirst({ where: { paymentId: payment.id } })
      : null;
    assert.equal(attempt?.status, "PROCESSING");
    assert.equal(attempt?.providerReference, null);
  });

  await context.test("keeps uncertain network failures processing", async () => {
    providerFailureMode = "network-error";
    const response = await postPayment(
      validRequest({
        customer: { name: "Network Failure Test", email: networkFailureCustomerEmail },
      }),
    );
    const result = await response.json();

    assert.equal(response.status, 502);
    assert.equal(result.error.code, "PAYSTACK_INITIALIZATION_FAILED");
    const payment = await prisma.payment.findFirst({
      where: { customer: { email: networkFailureCustomerEmail } },
    });
    assert.equal(payment?.status, "PROCESSING");
    assert.equal(payment?.paystackReference, null);
  });

  await context.test("keeps provider server errors processing", async () => {
    providerFailureMode = "server-error";
    const response = await postPayment(
      validRequest({
        customer: { name: "Provider Server Error Test", email: invalidResponseCustomerEmail },
      }),
    );
    const result = await response.json();

    assert.equal(response.status, 502);
    assert.equal(result.error.code, "PAYSTACK_INITIALIZATION_FAILED");
    const payment = await prisma.payment.findFirst({
      where: { customer: { email: invalidResponseCustomerEmail } },
    });
    assert.equal(payment?.status, "PROCESSING");
  });

  const invalidCases: Array<[string, unknown]> = [
    ["invalid email", validRequest({ customer: { name: "A", email: "bad-email" } })],
    ["empty phone", validRequest({ customer: { name: "A", email: customerEmail, phone: " " } })],
    ["missing customer", { amount: 1, currency: "NGN" }],
    ["missing customer name", validRequest({ customer: { email: customerEmail } })],
    ["empty customer name", validRequest({ customer: { name: " ", email: customerEmail } })],
    ["zero amount", validRequest({ amount: 0 })],
    ["negative amount", validRequest({ amount: -1 })],
    ["non-integer amount", validRequest({ amount: 1.5 })],
    ["invalid currency", validRequest({ currency: "ngn" })],
    ["missing currency", { customer: { name: "A", email: customerEmail }, amount: 1 }],
    ["missing amount", { customer: { name: "A", email: customerEmail }, currency: "NGN" }],
    ["client status", validRequest({ status: "SUCCEEDED" })],
    ["client reference", validRequest({ reference: "client-reference" })],
    ["client Paystack reference", validRequest({ paystackReference: "client-provider-reference" })],
    ["client creation timestamp", validRequest({ createdAt: "2026-10-08T00:00:00.000Z" })],
  ];

  for (const [description, body] of invalidCases) {
    await context.test(`rejects ${description}`, async () => {
      const response = await postPayment(body);
      const result = await response.json();
      assert.equal(response.status, 400);
      assert.equal(result.success, false);
      assert.equal(result.error.code, "VALIDATION_ERROR");
    });
  }

  await context.test("rejects malformed JSON", async () => {
    const response = await fetch(`${baseUrl}/api/v1/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.equal(result.error.code, "MALFORMED_JSON");
  });

  await context.test("returns 404 for an unknown payment reference", async () => {
    const response = await getVerification(`pay_${randomUUID()}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "PAYMENT_NOT_FOUND");
  });

  await context.test("does not contact Paystack when the payment has no provider reference", async () => {
    const fixture = await seedPayment({ paystackReference: null });
    const count = verificationRequests.length;
    const response = await getVerification(fixture.payment.reference);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "PAYSTACK_REFERENCE_MISSING");
    assert.equal(verificationRequests.length, count);
  });

  await context.test("verifies success and updates the associated payment and attempt", async () => {
    const fixture = await seedPayment();
    setVerificationResponse("success", { reference: fixture.providerReference! });
    const response = await getVerification(fixture.payment.reference);
    const result = await response.json();
    const [payment, attempt] = await Promise.all([
      prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } }),
      prisma.paymentAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } }),
    ]);

    assert.equal(response.status, 200);
    assert.equal(result.data.payment.status, "SUCCEEDED");
    assert.equal(payment.status, "SUCCEEDED");
    assert.equal(attempt.status, "SUCCEEDED");
    assert.equal(verificationRequests.at(-1)?.url.endsWith(encodeURIComponent(fixture.providerReference!)), true);
    assert.equal(verificationRequests.at(-1)?.authorization, `Bearer ${fakePaystackSecret}`);
    assert.equal(JSON.stringify(result).includes("raw_secret"), false);
    assert.equal(JSON.stringify(result).includes(fakePaystackSecret), false);
    assert.equal(JSON.stringify(result).includes("Private provider response detail"), false);
  });

  await context.test("rejects amount, currency, and provider reference mismatches without succeeding", async () => {
    const mismatches = [
      { name: "amount", value: { amount: 400_000 } },
      { name: "currency", value: { currency: "USD" } },
      { name: "provider reference", value: { reference: "PS_WRONG_REFERENCE" } },
    ];
    for (const mismatch of mismatches) {
      const fixture = await seedPayment();
      setVerificationResponse("success", {
        reference: fixture.providerReference!,
        ...mismatch.value,
      });
      const response = await getVerification(fixture.payment.reference);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } });
      assert.equal(response.status, 409, mismatch.name);
      assert.equal(payment.status, "PENDING", mismatch.name);
      assert.equal(attempt.status, "PENDING", mismatch.name);
    }
  });

  await context.test("maps failed and abandoned to FAILED, and provider pending to PROCESSING", async () => {
    const failed = await seedPayment();
    setVerificationResponse("failed", { reference: failed.providerReference! });
    const failedResponse = await getVerification(failed.payment.reference);
    assert.equal(failedResponse.status, 200);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: failed.payment.id } })).status, "FAILED");
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: failed.attempt.id } })).status, "FAILED");

    const abandoned = await seedPayment();
    setVerificationResponse("abandoned", { reference: abandoned.providerReference! });
    const abandonedResponse = await getVerification(abandoned.payment.reference);
    assert.equal(abandonedResponse.status, 200);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: abandoned.payment.id } })).status, "FAILED");
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: abandoned.attempt.id } })).status, "FAILED");

    const pending = await seedPayment();
    setVerificationResponse("pending", { reference: pending.providerReference! });
    const pendingResponse = await getVerification(pending.payment.reference);
    assert.equal(pendingResponse.status, 200);
    assert.equal((await pendingResponse.json()).data.payment.status, "PROCESSING");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: pending.payment.id } })).status, "PROCESSING");
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: pending.attempt.id } })).status, "PROCESSING");
  });

  await context.test("returns safe provider errors and keeps state unchanged", async () => {
    const fixture = await seedPayment();
    verificationHttpStatus = 502;
    verificationResponseBody = { status: false, message: "PRIVATE_PROVIDER_ERROR" };
    const response = await getVerification(fixture.payment.reference);
    const result = await response.json();
    assert.equal(response.status, 502);
    assert.equal(result.error.code, "PAYSTACK_VERIFICATION_FAILED");
    assert.equal(JSON.stringify(result).includes("PRIVATE_PROVIDER_ERROR"), false);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).status, "PENDING");
  });

  await context.test("keeps already successful and refunded payments from regressing", async () => {
    const succeeded = await seedPayment({ status: "SUCCEEDED" });
    const before = verificationRequests.length;
    setVerificationResponse("pending", { reference: succeeded.providerReference! });
    const successResponse = await getVerification(succeeded.payment.reference);
    assert.equal(successResponse.status, 200);
    assert.equal((await successResponse.json()).data.payment.status, "SUCCEEDED");
    assert.equal(verificationRequests.length, before);

    const refunded = await seedPayment({ status: "REFUNDED" });
    setVerificationResponse("success", { reference: refunded.providerReference! });
    const refundedResponse = await getVerification(refunded.payment.reference);
    assert.equal(refundedResponse.status, 409);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: refunded.payment.id } })).status, "REFUNDED");
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: refunded.attempt.id } })).status, "REFUNDED");

    const failed = await seedPayment({ status: "FAILED" });
    setVerificationResponse("success", { reference: failed.providerReference! });
    const failedResponse = await getVerification(failed.payment.reference);
    assert.equal(failedResponse.status, 409);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: failed.payment.id } })).status, "FAILED");
  });

  await context.test("treats Paystack reversed status as unmappable without changing state", async () => {
    const fixture = await seedPayment();
    setVerificationResponse("reversed", { reference: fixture.providerReference! });
    const response = await getVerification(fixture.payment.reference);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "UNMAPPABLE_PROVIDER_STATUS");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).status, "PENDING");
  });

  await context.test("rejects missing and invalid webhook signatures without persisting events", async () => {
    const fixture = await seedPayment();
    const event = chargeSuccessEvent(fixture);
    const before = await prisma.webhookEvent.count({ where: { provider: "PAYSTACK" } });

    const missing = await postPaystackWebhook(event, { signature: null });
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, "INVALID_SIGNATURE");

    const invalid = await postPaystackWebhook(event, { signature: "0".repeat(128) });
    assert.equal(invalid.status, 401);
    assert.equal(await prisma.webhookEvent.count({ where: { provider: "PAYSTACK" } }), before);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).status, "PENDING");
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } })).status, "PENDING");
  });

  await context.test("rejects malformed or incomplete webhook payloads", async () => {
    const malformed = await postPaystackWebhook({}, { rawBody: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "INVALID_PAYLOAD");

    const missingFields = await postPaystackWebhook({
      event: "charge.success",
      data: { id: ++nextWebhookTransactionId, status: "success", amount: 500_000 },
    });
    assert.equal(missingFields.status, 400);

    const invalidStructure = await postPaystackWebhook({ event: "charge.success", data: [] });
    assert.equal(invalidStructure.status, 400);
  });

  await context.test("acknowledges unsupported Paystack event types without processing them", async () => {
    const before = await prisma.webhookEvent.count({ where: { provider: "PAYSTACK" } });
    const response = await postPaystackWebhook({
      event: "transfer.success",
      data: { id: ++nextWebhookTransactionId },
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.data.unsupported, true);
    assert.equal(result.data.processed, false);
    assert.equal(await prisma.webhookEvent.count({ where: { provider: "PAYSTACK" } }), before);
  });

  await context.test("verifies the exact raw body signature and applies success atomically", async () => {
    const fixture = await seedPayment();
    const event = chargeSuccessEvent(fixture);
    const rawBody = JSON.stringify(event, null, 2);
    const signatureForDifferentBytes = createHmac("sha512", fakePaystackSecret)
      .update(JSON.stringify(event))
      .digest("hex");
    const beforeWrite = await prisma.webhookEvent.count({ where: { provider: "PAYSTACK" } });

    const wrongRawSignature = await postPaystackWebhook(event, {
      rawBody,
      signature: signatureForDifferentBytes,
    });
    assert.equal(wrongRawSignature.status, 401);
    assert.equal(await prisma.webhookEvent.count({ where: { provider: "PAYSTACK" } }), beforeWrite);

    const response = await postPaystackWebhook(event, { rawBody });
    const result = await response.json();
    const [payment, attempt, webhookEvent] = await Promise.all([
      prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } }),
      prisma.paymentAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } }),
      prisma.webhookEvent.findUniqueOrThrow({
        where: { provider_eventId: { provider: "PAYSTACK", eventId: `charge.success:${event.data.id}` } },
      }),
    ]);

    assert.equal(response.status, 200);
    assert.equal(result.data.processed, true);
    assert.equal(payment.status, "SUCCEEDED");
    assert.equal(attempt.status, "SUCCEEDED");
    assert.equal(webhookEvent.processed, true);
    assert.ok(webhookEvent.processedAt);
    assert.equal(webhookEvent.eventType, "charge.success");
    assert.equal(JSON.stringify(result).includes(fakePaystackSecret), false);
  });

  await context.test("transitions PROCESSING payments and their matching attempts to SUCCEEDED", async () => {
    const fixture = await seedPayment({ status: "PROCESSING" });
    const response = await postPaystackWebhook(chargeSuccessEvent(fixture));
    assert.equal(response.status, 200);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).status, "SUCCEEDED");
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } })).status, "SUCCEEDED");
    assert.equal(await prisma.paymentAttempt.count({ where: { paymentId: fixture.payment.id } }), 1);
  });

  await context.test("recognizes serial and concurrent duplicate webhooks using the database unique key", async () => {
    const serialFixture = await seedPayment();
    const serialEvent = chargeSuccessEvent(serialFixture);
    const first = await postPaystackWebhook(serialEvent);
    const second = await postPaystackWebhook(serialEvent);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).data.duplicate, true);
    assert.equal(await prisma.webhookEvent.count({
      where: { provider: "PAYSTACK", eventId: `charge.success:${serialEvent.data.id}` },
    }), 1);
    assert.equal(await prisma.paymentAttempt.count({ where: { paymentId: serialFixture.payment.id } }), 1);

    const concurrentFixture = await seedPayment();
    const concurrentEvent = chargeSuccessEvent(concurrentFixture);
    const concurrentResponses = await Promise.all([
      postPaystackWebhook(concurrentEvent),
      postPaystackWebhook(concurrentEvent),
    ]);
    const concurrentResults = await Promise.all(concurrentResponses.map((item) => item.json()));
    assert.ok(concurrentResponses.every((item) => item.status === 200));
    assert.equal(concurrentResults.filter((item) => item.data.duplicate === true).length, 1);
    assert.equal(await prisma.webhookEvent.count({
      where: { provider: "PAYSTACK", eventId: `charge.success:${concurrentEvent.data.id}` },
    }), 1);
    assert.equal(await prisma.paymentAttempt.count({ where: { paymentId: concurrentFixture.payment.id } }), 1);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: concurrentFixture.payment.id } })).status, "SUCCEEDED");
  });

  await context.test("treats an already successful payment as idempotent", async () => {
    const fixture = await seedPayment({ status: "SUCCEEDED" });
    const event = chargeSuccessEvent(fixture);
    const first = await postPaystackWebhook(event);
    const duplicate = await postPaystackWebhook(event);
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).data.duplicate, true);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).status, "SUCCEEDED");
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } })).status, "SUCCEEDED");
  });

  await context.test("does not resurrect FAILED, CANCELLED, or REFUNDED payments", async () => {
    for (const status of ["FAILED", "CANCELLED", "REFUNDED"] as const) {
      const fixture = await seedPayment({ status });
      const response = await postPaystackWebhook(chargeSuccessEvent(fixture));
      const body = await response.json();
      assert.equal(response.status, 409, status);
      assert.equal(body.error.code, "TERMINAL_PAYMENT_CONFLICT", status);
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).status, status);
      assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } })).status, status);
    }
  });

  await context.test("records but does not process amount, currency, or provider-reference mismatches", async () => {
    const amountFixture = await seedPayment();
    const amountEvent = chargeSuccessEvent(amountFixture, { amount: amountFixture.payment.amount - 1 });
    const amountResponse = await postPaystackWebhook(amountEvent);
    assert.equal(amountResponse.status, 409);
    assert.equal((await amountResponse.json()).error.code, "AMOUNT_MISMATCH");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: amountFixture.payment.id } })).status, "PENDING");
    const amountWebhook = await prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: "PAYSTACK", eventId: `charge.success:${amountEvent.data.id}` } },
    });
    assert.equal(amountWebhook.processed, false);
    assert.equal(amountWebhook.processedAt, null);

    const currencyFixture = await seedPayment();
    const currencyResponse = await postPaystackWebhook(
      chargeSuccessEvent(currencyFixture, { currency: "USD" }),
    );
    assert.equal(currencyResponse.status, 409);
    assert.equal((await currencyResponse.json()).error.code, "CURRENCY_MISMATCH");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: currencyFixture.payment.id } })).status, "PENDING");

    const referenceFixture = await seedPayment({ attemptProviderReference: "PS_attempt_reference" });
    const referenceResponse = await postPaystackWebhook(
      chargeSuccessEvent(referenceFixture, { reference: "PS_attempt_reference" }),
    );
    assert.equal(referenceResponse.status, 409);
    assert.equal((await referenceResponse.json()).error.code, "REFERENCE_MISMATCH");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: referenceFixture.payment.id } })).status, "PENDING");
  });

  await context.test("records unknown transaction references without creating payments", async () => {
    const fixture = await seedPayment();
    const paymentCount = await prisma.payment.count();
    const event = chargeSuccessEvent(fixture, { reference: `PS_UNKNOWN_${randomUUID()}` });
    const response = await postPaystackWebhook(event);
    const result = await response.json();
    const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: "PAYSTACK", eventId: `charge.success:${event.data.id}` } },
    });

    assert.equal(response.status, 200);
    assert.equal(result.data.processed, false);
    assert.equal(result.data.reason, "PAYMENT_NOT_FOUND");
    assert.equal(webhookEvent.processed, false);
    assert.equal(await prisma.payment.count(), paymentCount);
  });

  await context.test("verification remains idempotent for successful, failed, and processing payments", async () => {
    const succeeded = await seedPayment();
    setVerificationResponse("success", { reference: succeeded.providerReference! });
    const firstSuccess = await getVerification(succeeded.payment.reference);
    const verificationCountAfterSuccess = verificationRequests.length;
    const secondSuccess = await getVerification(succeeded.payment.reference);
    assert.equal(firstSuccess.status, 200);
    assert.equal(secondSuccess.status, 200);
    assert.equal((await secondSuccess.json()).data.payment.status, "SUCCEEDED");
    assert.equal(verificationRequests.length, verificationCountAfterSuccess);
    assert.equal(await prisma.paymentAttempt.count({ where: { paymentId: succeeded.payment.id } }), 1);

    const failed = await seedPayment();
    setVerificationResponse("failed", { reference: failed.providerReference! });
    const firstFailure = await getVerification(failed.payment.reference);
    const secondFailure = await getVerification(failed.payment.reference);
    assert.equal(firstFailure.status, 200);
    assert.equal(secondFailure.status, 200);
    assert.equal((await secondFailure.json()).data.payment.status, "FAILED");
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: failed.attempt.id } })).status, "FAILED");

    const processing = await seedPayment({ status: "PROCESSING" });
    setVerificationResponse("processing", { reference: processing.providerReference! });
    for (let call = 0; call < 3; call += 1) {
      const response = await getVerification(processing.payment.reference);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.payment.status, "PROCESSING");
    }
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: processing.attempt.id } })).status, "PROCESSING");
    assert.equal(await prisma.paymentAttempt.count({ where: { paymentId: processing.payment.id } }), 1);
  });

  await context.test("a concurrent verification and webhook success keep one consistent state", async () => {
    const fixture = await seedPayment();
    setVerificationResponse("success", { reference: fixture.providerReference! });
    const event = chargeSuccessEvent(fixture);
    const [verificationResponse, webhookResponse] = await Promise.all([
      getVerification(fixture.payment.reference),
      postPaystackWebhook(event),
    ]);
    assert.equal(verificationResponse.status, 200);
    assert.equal(webhookResponse.status, 200);
    const [payment, attempt, webhookEvent] = await Promise.all([
      prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } }),
      prisma.paymentAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } }),
      prisma.webhookEvent.findUniqueOrThrow({
        where: { provider_eventId: { provider: "PAYSTACK", eventId: `charge.success:${event.data.id}` } },
      }),
    ]);
    assert.equal(payment.status, "SUCCEEDED");
    assert.equal(attempt.status, "SUCCEEDED");
    assert.equal(webhookEvent.processed, true);
    assert.equal(await prisma.paymentAttempt.count({ where: { paymentId: fixture.payment.id } }), 1);
  });

  await context.test("webhook success is not regressed by a verification result based on an older read", async () => {
    for (const providerStatus of ["success", "processing", "failed"]) {
      const fixture = await seedPayment();
      setVerificationResponse(providerStatus, { reference: fixture.providerReference! });
      const barrier = holdNextVerificationResponse();
      const verificationPromise = getVerification(fixture.payment.reference);

      // Reaching this barrier proves verification already read the PENDING payment
      // and is waiting for the provider response before its database write.
      await barrier.started;
      const webhookResponse = await postPaystackWebhook(chargeSuccessEvent(fixture));
      barrier.release();
      const verificationResponse = await verificationPromise;

      assert.equal(webhookResponse.status, 200, providerStatus);
      assert.equal(verificationResponse.status, 200, providerStatus);
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).status, "SUCCEEDED");
      assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: fixture.attempt.id } })).status, "SUCCEEDED");
      assert.equal(await prisma.paymentAttempt.count({ where: { paymentId: fixture.payment.id } }), 1);
    }
  });

  await context.test("authentication registration validates and normalizes account input", async () => {
    const email = `Auth-${randomUUID()}@Example.COM`;
    const password = "Secure-test-password-123!";
    authEmails.add(email.toLowerCase());
    const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: " Auth Test ", email, password }),
    });
    const result = await response.json();
    const user = await prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
    assert.equal(response.status, 201);
    assert.equal(result.data.user.email, email.toLowerCase());
    assert.equal(result.data.user.name, "Auth Test");
    assert.equal("passwordHash" in result.data.user, false);
    assert.equal(user.passwordHash === password, false);
    assert.match(user.passwordHash, /^\$argon2id\$/);

    for (const invalidBody of [
      { name: "Valid", email: "not-an-email", password },
      { name: "   ", email: `empty-${randomUUID()}@example.com`, password },
      { name: "Valid", email: `weak-${randomUUID()}@example.com`, password: "short" },
      { name: "Valid", email: `extra-${randomUUID()}@example.com`, password, admin: true },
    ]) {
      const invalid = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalidBody),
      });
      assert.equal(invalid.status, 400);
    }
  });

  await context.test("registration links an existing customer without changing its payment history", async () => {
    const email = `legacy-${randomUUID()}@example.com`;
    authEmails.add(email);
    const customer = await prisma.customer.create({
      data: { email, name: "Existing Customer", phone: "08000000000" },
    });
    const payment = await prisma.payment.create({
      data: {
        reference: `LEGACY_${randomUUID()}`,
        customerId: customer.id,
        amount: 12500,
        currency: "NGN",
      },
    });
    const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Account", email: email.toUpperCase(), password: "Secure-test-password-123!" }),
    });
    assert.equal(response.status, 201);
    const [linkedCustomer, preservedPayment, userCount, customerCount] = await Promise.all([
      prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }),
      prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
      prisma.user.count({ where: { email } }),
      prisma.customer.count({ where: { email } }),
    ]);
    assert.equal(linkedCustomer.userId !== null, true);
    assert.equal(linkedCustomer.name, "Existing Customer");
    assert.equal(linkedCustomer.phone, "08000000000");
    assert.equal(preservedPayment.customerId, customer.id);
    assert.equal(userCount, 1);
    assert.equal(customerCount, 1);
  });

  await context.test("duplicate and concurrent registrations return conflicts", async () => {
    const email = `duplicate-${randomUUID()}@example.com`;
    authEmails.add(email);
    const body = JSON.stringify({ name: "Duplicate Test", email, password: "Secure-test-password-123!" });
    const first = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    const duplicate = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    assert.equal(first.status, 201);
    assert.equal(duplicate.status, 409);

    const concurrentEmail = `concurrent-${randomUUID()}@example.com`;
    authEmails.add(concurrentEmail);
    const concurrentBody = JSON.stringify({ name: "Concurrent Test", email: concurrentEmail, password: "Secure-test-password-123!" });
    const responses = await Promise.all([1, 2].map(() => fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" }, body: concurrentBody,
    })));
    assert.deepEqual(responses.map((item) => item.status).sort(), [201, 409]);
    assert.equal(await prisma.user.count({ where: { email: concurrentEmail } }), 1);
  });

  await context.test("login uses a generic error for unknown emails and wrong passwords", async () => {
    const email = `login-${randomUUID()}@example.com`;
    authEmails.add(email);
    const password = "Secure-test-password-123!";
    const registerResponse = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Login Test", email, password }),
    });
    assert.equal(registerResponse.status, 201);
    const good = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.toUpperCase(), password }),
    });
    const goodBody = await good.json();
    assert.equal(good.status, 200);
    assert.ok(goodBody.data.accessToken);
    assert.ok(goodBody.data.refreshToken);
    assert.equal("tokenHash" in goodBody.data, false);

    const wrong = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Wrong-password-123!" }),
    });
    const missing = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `unknown-${randomUUID()}@example.com`, password }),
    });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), await missing.json());

    const invalid = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, extra: "rejected" }),
    });
    assert.equal(invalid.status, 400);
  });

  await context.test("access-token middleware rejects missing, malformed, forged, and expired tokens", async () => {
    const path = `${baseUrl}/api/v1/payments/no-such-payment/verify`;
    const missing = await fetch(path);
    assert.equal(missing.status, 401);

    const tokenWith = (token: string) => fetch(path, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await tokenWith("not.a.jwt")).status, 401);
    const forged = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("forged-user").setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode("different_secret_key_more_than_32_bytes"));
    assert.equal((await tokenWith(forged)).status, 401);
    const expired = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("forged-user").setIssuedAt(1).setExpirationTime(2)
      .sign(new TextEncoder().encode(fakeJwtSecret));
    assert.equal((await tokenWith(expired)).status, 401);

    const owner = await seedPayment();
    const ownerToken = await tokenFor(owner.email);
    setVerificationResponse("success", { reference: owner.providerReference! });
    const allowed = await fetch(`${baseUrl}/api/v1/payments/${owner.payment.reference}/verify`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(allowed.status, 200);
  });

  await context.test("payment verification enforces ownership and creation requires authentication", async () => {
    const fixture = await seedPayment();
    const otherEmail = `other-owner-${randomUUID()}@example.com`;
    const otherToken = await tokenFor(otherEmail);
    const denied = await fetch(`${baseUrl}/api/v1/payments/${fixture.payment.reference}/verify`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    assert.equal(denied.status, 404);
    const unauthenticated = await fetch(`${baseUrl}/api/v1/payments`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(validRequest()),
    });
    assert.equal(unauthenticated.status, 401);
  });

  await context.test("refresh rotates hashed credentials and rejects reuse, expiry, and invalid tokens", async () => {
    const email = `refresh-${randomUUID()}@example.com`;
    authEmails.add(email);
    const password = "Secure-test-password-123!";
    const registration = await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Refresh Test", email, password }),
    });
    assert.equal(registration.status, 201);
    const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const login = await loginResponse.json();
    const initial = login.data.refreshToken as string;
    const stored = await prisma.refreshToken.findFirstOrThrow({ where: { user: { email } } });
    assert.notEqual(stored.tokenHash, initial);
    assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);

    const refreshed = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: initial }),
    });
    const refreshedBody = await refreshed.json();
    assert.equal(refreshed.status, 200);
    assert.ok(refreshedBody.data.accessToken);
    assert.ok(refreshedBody.data.refreshToken);
    assert.equal("tokenHash" in refreshedBody.data, false);
    const reused = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: initial }),
    });
    assert.equal(reused.status, 401);
    assert.equal((await reused.json()).error.code, "INVALID_CREDENTIALS");

    const invalid = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: "invalid-refresh-token" }),
    });
    assert.equal(invalid.status, 400);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const expiredToken = randomUUID() + randomUUID();
    await prisma.refreshToken.create({ data: {
      userId: user.id,
      tokenHash: createHash("sha256").update(expiredToken).digest("hex"),
      expiresAt: new Date(Date.now() - 1_000),
    } });
    const expiredResponse = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: expiredToken }),
    });
    assert.equal(expiredResponse.status, 401);

    const revokedToken = randomUUID() + randomUUID();
    await prisma.refreshToken.create({ data: {
      userId: user.id,
      tokenHash: createHash("sha256").update(revokedToken).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date(),
    } });
    const revokedResponse = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: revokedToken }),
    });
    assert.equal(revokedResponse.status, 401);

    const concurrentLoginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const concurrentLogin = await concurrentLoginResponse.json();
    const concurrentToken = concurrentLogin.data.refreshToken as string;
    const concurrentRequests = await Promise.all([1, 2].map(() => fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: concurrentToken }),
    })));
    assert.deepEqual(concurrentRequests.map((item) => item.status).sort(), [200, 401]);
    const concurrentTokenRecord = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: createHash("sha256").update(concurrentToken).digest("hex") },
    });
    assert.ok(concurrentTokenRecord.revokedAt);
    // One earlier session remains active; the concurrent pair may add only one more.
    assert.equal(await prisma.refreshToken.count({
      where: { user: { email }, revokedAt: null, expiresAt: { gt: new Date() } },
    }), 2);
  });

  await context.test("logout revokes its refresh token while leaving webhook authentication independent", async () => {
    const email = `logout-${randomUUID()}@example.com`;
    authEmails.add(email);
    const password = "Secure-test-password-123!";
    await fetch(`${baseUrl}/api/v1/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Logout Test", email, password }),
    });
    const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const login = await loginResponse.json();
    const logoutResponse = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${login.data.accessToken}` },
      body: JSON.stringify({ refreshToken: login.data.refreshToken }),
    });
    assert.equal(logoutResponse.status, 204);
    const repeatedLogout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${login.data.accessToken}` },
      body: JSON.stringify({ refreshToken: login.data.refreshToken }),
    });
    assert.equal(repeatedLogout.status, 204);
    const reused = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: login.data.refreshToken }),
    });
    assert.equal(reused.status, 401);

    const webhook = await postPaystackWebhook({ event: "transfer.success", data: { id: ++nextWebhookTransactionId } });
    assert.equal(webhook.status, 200);
  });
});
