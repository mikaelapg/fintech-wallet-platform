import type { FastifyInstance } from "fastify";
import { parse, toOpenApi } from "../../shared/validation.js";
import { readIdempotencyKey } from "../accounts/accounts.routes.js";
import { createTransferSchema, type TransfersService } from "./transfers.service.js";

export async function transferRoutes(app: FastifyInstance, opts: { transfersService: TransfersService }) {
  const { transfersService } = opts;
  app.addHook("onRequest", app.authenticate);

  app.post(
    "/transfers",
    {
      schema: {
        tags: ["transfers"],
        summary: "Transfer money to another user (idempotent)",
        description:
          "Requires an `Idempotency-Key` UUID header. Repeating the request with the same key returns the original transfer with `Idempotent-Replayed: true` instead of moving money twice.",
        security: [{ bearerAuth: [] }],
        headers: { type: "object", properties: { "idempotency-key": { type: "string", format: "uuid" } } },
        body: toOpenApi(createTransferSchema),
      },
    },
    async (request, reply) => {
      const idempotencyKey = readIdempotencyKey(request.headers);
      const { transfer, replayed } = await transfersService.create({
        userId: request.user.sub,
        accountId: request.user.accountId,
        idempotencyKey,
        input: parse(createTransferSchema, request.body),
      });
      if (replayed) reply.header("Idempotent-Replayed", "true");
      return reply.status(replayed ? 200 : 201).send(transfer);
    },
  );
}
