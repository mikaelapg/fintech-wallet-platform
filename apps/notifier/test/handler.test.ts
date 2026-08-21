import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildNotifications,
  handleMessage,
  type Notification,
  PermanentError,
  type ProcessedEventStore,
} from "../src/handler.js";

function makeEvent(overrides: Partial<{ description: string | null }> = {}) {
  return {
    id: randomUUID(),
    type: "transfer.completed" as const,
    occurredAt: new Date().toISOString(),
    payload: {
      transactionId: randomUUID(),
      amountCents: 12_345,
      debitAccountId: randomUUID(),
      creditAccountId: randomUUID(),
      initiatorUserId: randomUUID(),
      description: "Aluguel",
      ...overrides,
    },
  };
}

function memoryStore(): ProcessedEventStore {
  const seen = new Set<string>();
  return {
    async markIfNew(id) {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    async forget(id) {
      seen.delete(id);
    },
  };
}

describe("notifier handler", () => {
  it("notifies both sender and recipient", async () => {
    const sent: Notification[] = [];
    const event = makeEvent();

    const result = await handleMessage(event, {
      channel: { send: async (n) => void sent.push(n) },
      store: memoryStore(),
    });

    expect(result).toBe("processed");
    expect(sent.map((n) => n.accountId)).toEqual([
      event.payload.debitAccountId,
      event.payload.creditAccountId,
    ]);
    expect(sent[1]?.body.replace(/\s/g, " ")).toContain("R$ 123,45");
  });

  it("ignores duplicate deliveries of the same event", async () => {
    const send = vi.fn(async () => {});
    const deps = { channel: { send }, store: memoryStore() };
    const event = makeEvent();

    await handleMessage(event, deps);
    const second = await handleMessage(event, deps);

    expect(second).toBe("duplicate");
    expect(send).toHaveBeenCalledTimes(2); // two notifications, from the first delivery only
  });

  it("allows a retry to reprocess after a delivery failure", async () => {
    const store = memoryStore();
    const failing = { send: vi.fn().mockRejectedValueOnce(new Error("provider down")) };
    const event = makeEvent();

    await expect(handleMessage(event, { channel: failing, store })).rejects.toThrow("provider down");
    const retry = await handleMessage(event, { channel: { send: async () => {} }, store });

    expect(retry).toBe("processed");
  });

  it("treats malformed messages as permanent failures", async () => {
    await expect(
      handleMessage({ type: "transfer.completed" }, { channel: { send: async () => {} }, store: memoryStore() }),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it("omits the note when the transfer has no description", () => {
    const [sender] = buildNotifications(makeEvent({ description: null }));
    expect(sender?.body).not.toContain('"');
  });
});
