import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app } from "../app.js";
import { prisma } from "../config/prisma.js";

const customerEmail = `stage3-${randomUUID()}@example.com`;
let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  await prisma.payment.deleteMany({ where: { customer: { email: customerEmail } } });
  await prisma.customer.deleteMany({ where: { email: customerEmail } });
  await prisma.$disconnect();
});

async function postPayment(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/payments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

test("payment API creates and validates payments", { timeout: 60_000 }, async (context) => {
  await context.test("health endpoint still works", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  await context.test("creates a pending payment and a new customer", async () => {
    const response = await postPayment(validRequest());
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.success, true);
    assert.equal(result.data.payment.status, "PENDING");
    assert.match(result.data.payment.reference, /^pay_[0-9a-f-]{36}$/);
    assert.equal(result.data.payment.amount, 500_000);
    assert.equal(result.data.customer.email, customerEmail);

    const [customer, payment] = await Promise.all([
      prisma.customer.findUnique({ where: { email: customerEmail } }),
      prisma.payment.findUnique({ where: { reference: result.data.payment.reference } }),
    ]);
    assert.ok(customer);
    assert.equal(payment?.customerId, customer.id);
    assert.equal(payment?.status, "PENDING");
    assert.equal(payment?.paystackReference, null);
    assert.equal("customerId" in result.data.payment, false);
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
});
