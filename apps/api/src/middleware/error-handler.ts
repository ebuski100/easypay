import { Prisma } from "@prisma/client";
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

function isMalformedJson(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  );
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  if (isMalformedJson(error)) {
    response.status(400).json({
      success: false,
      error: { code: "MALFORMED_JSON", message: "Request body contains invalid JSON." },
    });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request body is invalid.",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    response.status(409).json({
      success: false,
      error: { code: "CONFLICT", message: "A record with these details already exists." },
    });
    return;
  }

  console.error("Unhandled API error:", {
    name: error instanceof Error ? error.name : "UnknownError",
    ...(error instanceof Prisma.PrismaClientKnownRequestError ? { prismaCode: error.code } : {}),
    method: request.method,
    path: request.path,
  });
  response.status(500).json({
    success: false,
    error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred." },
  });
};
