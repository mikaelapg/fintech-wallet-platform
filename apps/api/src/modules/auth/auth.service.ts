import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { accounts, users } from "../../db/schema.js";
import { AppError, Errors } from "../../shared/errors.js";
import { hasPgErrorCode, PG_UNIQUE_VIOLATION } from "../../shared/pg-errors.js";

const BCRYPT_COST = 12;

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  password: z
    .string()
    .min(10, "Password must have at least 10 characters")
    .max(128)
    .regex(/[A-Za-z]/, "Password must contain a letter")
    .regex(/\d/, "Password must contain a number"),
});

export const loginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(128),
});

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  accountId: string;
}

export class AuthService {
  // Compared against when the email does not exist, so a login takes the same
  // time either way and response timing can't reveal which emails are registered.
  private readonly dummyHash: Promise<string>;

  constructor(
    private readonly db: Database,
    private readonly bcryptCost = BCRYPT_COST,
  ) {
    this.dummyHash = bcrypt.hash("timing-equalizer", bcryptCost);
  }

  async register(input: z.infer<typeof registerSchema>): Promise<PublicUser> {
    const passwordHash = await bcrypt.hash(input.password, this.bcryptCost);
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ name: input.name, email: input.email, passwordHash })
          .returning({ id: users.id, name: users.name, email: users.email });
        if (!user) throw new AppError("INTERNAL", "Failed to create user", 500);

        const [account] = await tx
          .insert(accounts)
          .values({ userId: user.id, kind: "user" })
          .returning({ id: accounts.id });
        if (!account) throw new AppError("INTERNAL", "Failed to create account", 500);

        return { ...user, accountId: account.id };
      });
    } catch (error) {
      if (hasPgErrorCode(error, PG_UNIQUE_VIOLATION)) throw Errors.emailTaken();
      throw error;
    }
  }

  async authenticate(input: z.infer<typeof loginSchema>): Promise<PublicUser> {
    const [row] = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        passwordHash: users.passwordHash,
        accountId: accounts.id,
      })
      .from(users)
      .innerJoin(accounts, eq(accounts.userId, users.id))
      .where(eq(sql`lower(${users.email})`, input.email))
      .limit(1);

    const valid = await bcrypt.compare(input.password, row?.passwordHash ?? (await this.dummyHash));
    if (!row || !valid) throw Errors.invalidCredentials();

    const { passwordHash: _hash, ...user } = row;
    return user;
  }

  async findById(userId: string): Promise<PublicUser> {
    const [row] = await this.db
      .select({ id: users.id, name: users.name, email: users.email, accountId: accounts.id })
      .from(users)
      .innerJoin(accounts, eq(accounts.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) throw Errors.notFound("User");
    return row;
  }
}
