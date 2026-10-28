export const PG_UNIQUE_VIOLATION = "23505";

/** drizzle wraps driver errors, so walk the `cause` chain looking for a pg error code. */
export function hasPgErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    if ("code" in current && (current as { code: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
