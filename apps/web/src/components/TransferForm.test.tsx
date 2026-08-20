import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransferForm } from "./TransferForm";

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function fillAndSubmit(email: string, amount: string) {
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText(/e-mail do destinatário/i));
  await user.type(screen.getByLabelText(/e-mail do destinatário/i), email);
  await user.clear(screen.getByLabelText(/valor/i));
  await user.type(screen.getByLabelText(/valor/i), amount);
  await user.click(screen.getByRole("button", { name: /transferir/i }));
}

describe("TransferForm", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("sends the amount in cents with an Idempotency-Key header", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { id: "tx-1" }));
    renderWithClient(<TransferForm balanceCents={10_000} />);

    await fillAndSubmit("bob@example.com", "25,90");

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/realizada/i));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/transfers");
    expect(JSON.parse(init!.body as string)).toEqual({ recipientEmail: "bob@example.com", amountCents: 2590 });
    expect(new Headers(init!.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses the same Idempotency-Key when retrying a failed attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(json(500, { status: 500, code: "INTERNAL", title: "Internal Server Error" }))
      .mockResolvedValueOnce(json(201, { id: "tx-1" }));
    renderWithClient(<TransferForm balanceCents={10_000} />);

    await fillAndSubmit("bob@example.com", "10");
    await screen.findByRole("alert");
    await userEvent.setup().click(screen.getByRole("button", { name: /transferir/i }));
    await screen.findByRole("status");

    const keys = fetchMock.mock.calls.map(([, init]) => new Headers(init!.headers).get("Idempotency-Key"));
    expect(keys[0]).toBe(keys[1]);
  });

  it("validates before calling the API", async () => {
    renderWithClient(<TransferForm balanceCents={1_000} />);

    await fillAndSubmit("bob@example.com", "abc");
    expect(screen.getByRole("alert")).toHaveTextContent(/valor válido/i);

    await fillAndSubmit("bob@example.com", "50,00");
    expect(screen.getByRole("alert")).toHaveTextContent(/saldo disponível/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a friendly message for business errors", async () => {
    fetchMock.mockResolvedValueOnce(
      json(422, { status: 422, code: "INSUFFICIENT_FUNDS", title: "Insufficient balance" }),
    );
    renderWithClient(<TransferForm balanceCents={undefined} />);

    await fillAndSubmit("bob@example.com", "10");

    expect(await screen.findByRole("alert")).toHaveTextContent("Saldo insuficiente");
  });
});
