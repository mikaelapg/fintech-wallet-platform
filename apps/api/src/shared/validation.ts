import { z } from "zod";
import { Errors } from "./errors.js";

/** Parses untrusted input with zod and raises a 400 with field-level details. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Errors.validation(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Converts a zod schema into a JSON Schema that @fastify/swagger can render. */
export function toOpenApi(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return jsonSchema;
}
