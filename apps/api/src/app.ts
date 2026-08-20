import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { Env } from "./config/env.js";
import type { Database } from "./db/client.js";
import { accountRoutes } from "./modules/accounts/accounts.routes.js";
import { AccountsService } from "./modules/accounts/accounts.service.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { transferRoutes } from "./modules/transfers/transfers.routes.js";
import { TransfersService } from "./modules/transfers/transfers.service.js";
import { authPlugin } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";

export interface AppDependencies {
  env: Env;
  db: Database;
  pool: pg.Pool;
  redis: Redis;
  /** Lower bcrypt cost keeps the test suite fast. Production uses the default. */
  bcryptCost?: number;
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { env, db, pool, redis } = deps;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.body.password"],
      ...(env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
    },
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? crypto.randomUUID(),
    trustProxy: true,
  });

  // Requests are validated with zod inside the handlers (single source of truth
  // for types and validation). The JSON schemas below only feed OpenAPI docs.
  app.setValidatorCompiler(() => (data) => ({ value: data }));

  registerErrorHandler(app);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.CORS_ORIGIN.split(","), credentials: true });
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: "1 minute",
    redis,
    nameSpace: "ratelimit:",
    skipOnError: true,
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Fintech Wallet API",
        version: "1.0.0",
        description: "Digital wallet with a double-entry ledger and idempotent transfers.",
      },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(authPlugin, { secret: env.JWT_SECRET, expiresIn: env.JWT_EXPIRES_IN });

  const authService = new AuthService(db, deps.bcryptCost);
  const accountsService = new AccountsService(db, redis, env.BALANCE_CACHE_TTL_SECONDS);
  const transfersService = new TransfersService(db, redis, accountsService);

  app.get("/health/live", { schema: { hide: true } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { schema: { hide: true } }, async (_request, reply) => {
    const [database, cache] = await Promise.allSettled([pool.query("SELECT 1"), redis.ping()]);
    const ready = database.status === "fulfilled" && cache.status === "fulfilled";
    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ok" : "unavailable",
      checks: { database: database.status, redis: cache.status },
    });
  });

  await app.register(authRoutes, { authService });
  await app.register(accountRoutes, { accountsService });
  await app.register(transferRoutes, { transfersService });

  return app;
}
