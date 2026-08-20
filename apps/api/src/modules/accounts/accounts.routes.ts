import type { FastifyInstance } from "fastify";
import { Errors } from "../../shared/errors.js";
import { parse, toOpenApi } from "../../shared/validation.js";
import { idempotencyKeySchema } from "../ledger/idempotency.js";
import { type AccountsService, depositSchema, statementQuerySchema } from "./accounts.service.js";

export function readIdempotencyKey(headers: Record<string, unknown>): string {
  const parsed = idempotencyKeySchema.safeParse(headers["idempotency-key"]);
  if (!parsed.success) throw Errors.idempotencyKeyRequired();
  return parsed.data;
}

export async function accountRoutes(app: FastifyInstance, opts: { accountsService: AccountsService }) {
  const { accountsService } = opts;
  app.addHook("onRequest", app.authenticate);

  app.get(
    "/accounts/me/balance",
    { schema: { tags: ["accounts"], summary: "Current balance (Redis cache-aside)", security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const { cached, ...balance } = await accountsService.getBalance(request.user.accountId);
      reply.header("X-Cache", cached ? "HIT" : "MISS");
      return balance;
    },
  );

  app.get(
    "/accounts/me/statement",
    {
      schema: {
        tags: ["accounts"],
        summary: "Account statement with cursor pagination",
        security: [{ bearerAuth: [] }],
        querystring: toOpenApi(statementQuerySchema),
      },
    },
    async (request) =>
      accountsService.getStatement(request.user.accountId, parse(statementQuerySchema, request.query)),
  );

  app.post(
    "/accounts/me/deposits",
    {
      schema: {
        tags: ["accounts"],
        summary: "Simulated cash-in (idempotent)",
        security: [{ bearerAuth: [] }],
        headers: { type: "object", properties: { "idempotency-key": { type: "string", format: "uuid" } } },
        body: toOpenApi(depositSchema),
      },
    },
    async (request, reply) => {
      const idempotencyKey = readIdempotencyKey(request.headers);
      const outcome = await accountsService.deposit({
        userId: request.user.sub,
        accountId: request.user.accountId,
        idempotencyKey,
        input: parse(depositSchema, request.body),
      });
      if (outcome.replayed) {
        reply.header("Idempotent-Replayed", "true");
        return reply.status(200).send({ transactionId: outcome.transactionId });
      }
      return reply.status(201).send({
        transactionId: outcome.value.transactionId,
        balanceCents: outcome.value.creditBalanceAfterCents,
      });
    },
  );
}
