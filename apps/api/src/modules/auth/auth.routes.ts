import type { FastifyInstance } from "fastify";
import { parse, toOpenApi } from "../../shared/validation.js";
import { type AuthService, loginSchema, registerSchema } from "./auth.service.js";

export async function authRoutes(app: FastifyInstance, opts: { authService: AuthService }) {
  const { authService } = opts;

  app.post(
    "/auth/register",
    { schema: { tags: ["auth"], summary: "Create a user and its wallet account", body: toOpenApi(registerSchema) } },
    async (request, reply) => {
      const user = await authService.register(parse(registerSchema, request.body));
      const accessToken = await reply.jwtSign({ sub: user.id, accountId: user.accountId });
      return reply.status(201).send({ user, accessToken });
    },
  );

  app.post(
    "/auth/login",
    {
      // Brute-force protection: much stricter than the global limit.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { tags: ["auth"], summary: "Exchange credentials for a JWT", body: toOpenApi(loginSchema) },
    },
    async (request, reply) => {
      const user = await authService.authenticate(parse(loginSchema, request.body));
      const accessToken = await reply.jwtSign({ sub: user.id, accountId: user.accountId });
      return { user, accessToken };
    },
  );

  app.get(
    "/me",
    {
      onRequest: [app.authenticate],
      schema: { tags: ["auth"], summary: "Current user", security: [{ bearerAuth: [] }] },
    },
    async (request) => authService.findById(request.user.sub),
  );
}
