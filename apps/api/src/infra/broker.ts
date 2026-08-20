import amqp from "amqplib";

export const EVENTS_EXCHANGE = "wallet.events";

export interface OutgoingMessage {
  id: string;
  type: string;
  occurredAt: string;
  payload: unknown;
}

/** Port used by the outbox relay. Tests use an in-memory implementation. */
export interface EventPublisher {
  publish(message: OutgoingMessage): Promise<void>;
  close(): Promise<void>;
}

/**
 * RabbitMQ publisher using a confirm channel: publish() only resolves after
 * the broker has acknowledged the message, so the relay never marks an event
 * as published when it was actually lost.
 */
export async function createRabbitPublisher(url: string): Promise<EventPublisher> {
  const connection = await amqp.connect(url);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(EVENTS_EXCHANGE, "topic", { durable: true });

  return {
    async publish(message) {
      const body = Buffer.from(JSON.stringify(message));
      await new Promise<void>((resolve, reject) => {
        channel.publish(
          EVENTS_EXCHANGE,
          message.type,
          body,
          {
            persistent: true,
            contentType: "application/json",
            messageId: message.id,
            type: message.type,
            timestamp: Date.parse(message.occurredAt) / 1000,
          },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    },
    async close() {
      await channel.close();
      await connection.close();
    },
  };
}
