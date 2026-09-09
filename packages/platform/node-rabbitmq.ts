import * as amqp from "amqplib";
import type {
  Channel,
  ChannelModel,
  ConfirmChannel as AmqpConfirmChannel,
  ConsumeMessage,
} from "amqplib";
import { JOB_TYPES, type JobType } from "../events/index.ts";
import {
  RabbitTaskPublisher,
  type ConfirmChannel as ConfirmChannelPort,
} from "./rabbitmq.ts";
import {
  integerEnvironment,
  rabbitConnectionString,
  type RuntimeEnvironment,
} from "./runtime-config.ts";
import type { Delivery } from "../../workers/shared/worker.ts";

function attachErrorGuards(connection: ChannelModel, channel: Channel): void {
  connection.on("error", () => undefined);
  connection.on("handler-error", () => undefined);
  channel.on("error", () => undefined);
}

function adaptConfirmChannel(channel: AmqpConfirmChannel): ConfirmChannelPort {
  return {
    publish(exchange, routingKey, body, options, confirm) {
      return channel.publish(
        exchange,
        routingKey,
        Buffer.from(body),
        options,
        confirm,
      );
    },
    on(event, listener) {
      channel.on(event, listener);
      return channel;
    },
    off(event, listener) {
      channel.off(event, listener);
      return channel;
    },
  };
}

async function closeChannel(channel: Channel): Promise<void> {
  try {
    await channel.close();
  } catch {
    // Already-closed channels are safe during shutdown.
  }
}

async function closeConnection(connection: ChannelModel): Promise<void> {
  try {
    await connection.close();
  } catch {
    // Connection may already be closed after a broker/network failure.
  }
}

export interface ConnectedRabbitPublisher {
  readonly publisher: RabbitTaskPublisher;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export async function connectRabbitPublisher(
  environment: RuntimeEnvironment = process.env,
): Promise<ConnectedRabbitPublisher> {
  const endpoint = new URL(rabbitConnectionString(environment));
  endpoint.searchParams.set(
    "heartbeat",
    String(integerEnvironment(environment, "RABBITMQ_HEARTBEAT_SECONDS", 20, 5, 120)),
  );
  const connection = await amqp.connect(endpoint.toString(), {
    timeout: integerEnvironment(environment, "RABBITMQ_CONNECT_TIMEOUT_MS", 10_000, 500, 60_000),
  });
  const channel = await connection.createConfirmChannel();
  attachErrorGuards(connection, channel);
  await channel.checkExchange("fs.commands");

  const publisher = new RabbitTaskPublisher(
    adaptConfirmChannel(channel),
    integerEnvironment(environment, "RABBITMQ_CONFIRM_TIMEOUT_MS", 10_000, 100, 60_000),
  );

  return {
    publisher,
    async ping() {
      await channel.checkExchange("fs.commands");
    },
    async close() {
      publisher.dispose();
      await closeChannel(channel);
      await closeConnection(connection);
    },
  };
}

export interface ConnectedRabbitConsumer {
  readonly queue: JobType;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export async function connectRabbitConsumer(
  queue: JobType,
  handler: (delivery: Delivery) => Promise<void>,
  environment: RuntimeEnvironment = process.env,
): Promise<ConnectedRabbitConsumer> {
  if (!JOB_TYPES.includes(queue)) throw new Error("INVALID_JOB_QUEUE");

  const endpoint = new URL(rabbitConnectionString(environment));
  endpoint.searchParams.set(
    "heartbeat",
    String(integerEnvironment(environment, "RABBITMQ_HEARTBEAT_SECONDS", 20, 5, 120)),
  );
  const connection = await amqp.connect(endpoint.toString(), {
    timeout: integerEnvironment(environment, "RABBITMQ_CONNECT_TIMEOUT_MS", 10_000, 500, 60_000),
  });
  const channel = await connection.createChannel();
  attachErrorGuards(connection, channel);
  await channel.checkQueue(queue);
  await channel.prefetch(
    integerEnvironment(environment, "RABBITMQ_CONSUMER_PREFETCH", 8, 1, 128),
  );

  const reply = await channel.consume(
    queue,
    (message: ConsumeMessage | null) => {
      if (message === null) return;

      let body: unknown;
      try {
        body = JSON.parse(message.content.toString("utf8"));
      } catch {
        channel.nack(message, false, false);
        return;
      }

      let settled = false;
      const delivery: Delivery = {
        body,
        ack() {
          if (settled) return;
          settled = true;
          channel.ack(message);
        },
        deadLetter() {
          if (settled) return;
          settled = true;
          channel.nack(message, false, false);
        },
      };

      void handler(delivery).catch(() => {
        if (!settled) {
          settled = true;
          channel.nack(message, false, true);
        }
      });
    },
    { noAck: false },
  );

  return {
    queue,
    async ping() {
      await channel.checkQueue(queue);
    },
    async close() {
      try {
        await channel.cancel(reply.consumerTag);
      } catch {
        // The broker may already have cancelled the consumer.
      }
      await closeChannel(channel);
      await closeConnection(connection);
    },
  };
}
