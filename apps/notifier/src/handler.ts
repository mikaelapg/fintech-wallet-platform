import { z } from "zod";

export const transferCompletedSchema = z.object({
  id: z.uuid(),
  type: z.literal("transfer.completed"),
  occurredAt: z.iso.datetime({ offset: true }),
  payload: z.object({
    transactionId: z.uuid(),
    amountCents: z.number().int().positive(),
    debitAccountId: z.uuid(),
    creditAccountId: z.uuid(),
    initiatorUserId: z.uuid(),
    description: z.string().nullable(),
  }),
});

export type TransferCompleted = z.infer<typeof transferCompletedSchema>;

export interface Notification {
  accountId: string;
  title: string;
  body: string;
}

/** Delivery channel (push, e-mail, SMS...). Kept behind an interface so it can be swapped or mocked. */
export interface NotificationChannel {
  send(notification: Notification): Promise<void>;
}

/** Remembers processed event ids. Delivery is at-least-once, so handlers must be idempotent. */
export interface ProcessedEventStore {
  /** Returns true the first time an id is seen, false for duplicates. */
  markIfNew(eventId: string): Promise<boolean>;
  forget(eventId: string): Promise<void>;
}

export class PermanentError extends Error {}

const brl = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);

export function buildNotifications(event: TransferCompleted): Notification[] {
  const amount = brl(event.payload.amountCents);
  const note = event.payload.description ? ` (${event.payload.description})` : "";
  return [
    {
      accountId: event.payload.debitAccountId,
      title: "Transferência enviada",
      body: `Você enviou ${amount}${note}.`,
    },
    {
      accountId: event.payload.creditAccountId,
      title: "Você recebeu uma transferência",
      body: `Você recebeu ${amount}${note}.`,
    },
  ];
}

export async function handleMessage(
  raw: unknown,
  deps: { channel: NotificationChannel; store: ProcessedEventStore },
): Promise<"processed" | "duplicate"> {
  const parsed = transferCompletedSchema.safeParse(raw);
  // A malformed message will never succeed; retrying it only wastes resources.
  if (!parsed.success) throw new PermanentError(`Invalid message: ${parsed.error.message}`);

  const event = parsed.data;
  if (!(await deps.store.markIfNew(event.id))) return "duplicate";

  try {
    for (const notification of buildNotifications(event)) await deps.channel.send(notification);
    return "processed";
  } catch (error) {
    // Allow the retry to process it again.
    await deps.store.forget(event.id);
    throw error;
  }
}
