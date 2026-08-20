export interface Problem {
  status: number;
  code: string;
  title: string;
  errors?: { path: string; message: string }[];
}

export class ApiError extends Error {
  constructor(public readonly problem: Problem) {
    super(problem.title);
    this.name = "ApiError";
  }
}

export interface User {
  id: string;
  name: string;
  email: string;
  accountId: string;
}

export interface Balance {
  accountId: string;
  currency: string;
  balanceCents: number;
}

export interface StatementEntry {
  id: number;
  transactionId: string;
  type: "deposit" | "transfer";
  direction: "debit" | "credit";
  amountCents: number;
  balanceAfterCents: number;
  description: string | null;
  createdAt: string;
}

export interface StatementPage {
  items: StatementEntry[];
  nextCursor: number | null;
}

const BASE_URL = import.meta.env.VITE_API_URL ?? "/api";

type TokenGetter = () => string | null;
let getToken: TokenGetter = () => null;
let onUnauthorized: () => void = () => {};

export function configureClient(options: { getToken: TokenGetter; onUnauthorized: () => void }) {
  getToken = options.getToken;
  onUnauthorized = options.onUnauthorized;
}

async function request<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);

  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (response.status === 401 && token) onUnauthorized();

  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      body ?? { status: response.status, code: "NETWORK", title: "Não foi possível falar com o servidor" },
    );
  }
  return body as T;
}

export const api = {
  register: (input: { name: string; email: string; password: string }) =>
    request<{ user: User; accessToken: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  login: (input: { email: string; password: string }) =>
    request<{ user: User; accessToken: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  balance: () => request<Balance>("/accounts/me/balance"),
  statement: (cursor?: number) =>
    request<StatementPage>(`/accounts/me/statement?limit=10${cursor ? `&cursor=${cursor}` : ""}`),
  deposit: (amountCents: number, idempotencyKey: string) =>
    request<{ transactionId: string }>("/accounts/me/deposits", {
      method: "POST",
      body: JSON.stringify({ amountCents }),
      idempotencyKey,
    }),
  transfer: (
    input: { recipientEmail: string; amountCents: number; description?: string },
    idempotencyKey: string,
  ) =>
    request<{ id: string }>("/transfers", {
      method: "POST",
      body: JSON.stringify(input),
      idempotencyKey,
    }),
};

const MESSAGES: Record<string, string> = {
  INSUFFICIENT_FUNDS: "Saldo insuficiente para esta transferência.",
  SELF_TRANSFER: "Você não pode transferir para a sua própria conta.",
  NOT_FOUND: "Destinatário não encontrado.",
  INVALID_CREDENTIALS: "E-mail ou senha incorretos.",
  EMAIL_TAKEN: "Este e-mail já está cadastrado.",
  REQUEST_IN_PROGRESS: "Essa operação já está sendo processada.",
  FST_ERR_RATE_LIMIT: "Muitas tentativas. Aguarde um minuto.",
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.problem.errors?.length) return error.problem.errors.map((e) => e.message).join(" ");
    return MESSAGES[error.problem.code] ?? error.problem.title;
  }
  return "Algo deu errado. Tente novamente.";
}
