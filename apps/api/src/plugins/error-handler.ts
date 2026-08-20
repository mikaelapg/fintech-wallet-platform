import type { FastifyError, FastifyInstance } from "fastify";
import { AppError } from "../shared/errors.js";

/**
 * Every error leaves the API as an RFC 9457 problem document. Unexpected
 * errors are logged with the request id and never leak internals to clients.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .type("application/problem+json")
        .send({
          type: `https://wallet.dev/errors/${error.code.toLowerCase()}`,
          title: error.message,
          status: error.statusCode,
          code: error.code,
          ...(error.details ? { errors: error.details } : {}),
          instance: request.url,
          requestId: request.id,
        });
    }

    // Fastify's own client errors (malformed JSON, rate limit, payload too large).
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply.status(status).type("application/problem+json").send({
        type: "about:blank",
        title: error.message,
        status,
        code: error.code ?? "BAD_REQUEST",
        instance: request.url,
        requestId: request.id,
      });
    }

    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).type("application/problem+json").send({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      code: "INTERNAL",
      instance: request.url,
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).type("application/problem+json").send({
      type: "about:blank",
      title: "Route not found",
      status: 404,
      code: "ROUTE_NOT_FOUND",
      instance: request.url,
      requestId: request.id,
    }),
  );
}
