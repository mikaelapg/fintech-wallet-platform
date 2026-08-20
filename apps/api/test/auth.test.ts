import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, registerUser, resetState, type TestContext } from "./helpers.js";

describe("auth", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  beforeEach(() => resetState(ctx));
  afterAll(() => ctx.close());

  it("registers a user, creates a wallet account and returns a JWT", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Ana Souza", email: "Ana@Example.com", password: "s3cure-password" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user).toMatchObject({ name: "Ana Souza", email: "ana@example.com" });
    expect(body.user.accountId).toEqual(expect.any(String));
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(body.accessToken).toEqual(expect.any(String));
  });

  it("rejects a duplicated email regardless of casing", async () => {
    const payload = { name: "Ana", email: "ana@example.com", password: "s3cure-password" };
    await ctx.app.inject({ method: "POST", url: "/auth/register", payload });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { ...payload, email: "ANA@example.com" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("EMAIL_TAKEN");
  });

  it("returns field-level validation errors as problem details", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "A", email: "not-an-email", password: "short" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const paths = response.json().errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["name", "email", "password"]));
  });

  it("logs in with valid credentials and rejects invalid ones with the same error", async () => {
    const user = await registerUser(ctx);

    const ok = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: "s3cure-password" },
    });
    const wrongPassword = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: user.email, password: "wrong-password1" },
    });
    const unknownEmail = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@example.com", password: "wrong-password1" },
    });

    expect(ok.statusCode).toBe(200);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Same code for both cases: the API must not reveal which emails exist.
    expect(wrongPassword.json().code).toBe(unknownEmail.json().code);
  });

  it("protects /me with a bearer token", async () => {
    const user = await registerUser(ctx, "Bia");

    const anonymous = await ctx.app.inject({ method: "GET", url: "/me" });
    const authenticated = await ctx.app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${user.token}` },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({ id: user.id, name: "Bia" });
  });
});
