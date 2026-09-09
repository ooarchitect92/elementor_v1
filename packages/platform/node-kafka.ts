import { Kafka, logLevel } from "kafkajs";
import type { Admin, Producer, ProducerRecord } from "kafkajs";
import { TOPICS } from "../events/index.ts";
import { KafkaEventPublisher } from "./kafka.ts";
import {
  integerEnvironment,
  kafkaBrokerList,
  type RuntimeEnvironment,
} from "./runtime-config.ts";

export interface ConnectedKafkaPublisher {
  readonly publisher: KafkaEventPublisher;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export async function connectKafkaPublisher(
  environment: RuntimeEnvironment = process.env,
): Promise<ConnectedKafkaPublisher> {
  const clientId = environment.KAFKA_CLIENT_ID?.trim() || "forgestudio-outbox";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(clientId)) {
    throw new Error("INVALID_ENVIRONMENT:KAFKA_CLIENT_ID");
  }

  const kafka = new Kafka({
    clientId,
    brokers: kafkaBrokerList(environment),
    connectionTimeout: integerEnvironment(
      environment,
      "KAFKA_CONNECT_TIMEOUT_MS",
      5_000,
      500,
      60_000,
    ),
    requestTimeout: integerEnvironment(
      environment,
      "KAFKA_REQUEST_TIMEOUT_MS",
      15_000,
      1_000,
      120_000,
    ),
    retry: {
      initialRetryTime: 300,
      retries: integerEnvironment(environment, "KAFKA_CONNECT_RETRIES", 8, 0, 50),
      maxRetryTime: 30_000,
    },
    logLevel: logLevel.NOTHING,
  });

  const producer: Producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    allowAutoTopicCreation: false,
    transactionTimeout: 30_000,
  });
  const admin: Admin = kafka.admin();

  await producer.connect();
  try {
    await admin.connect();
    const topics = await admin.listTopics();
    for (const topic of TOPICS) {
      if (!topics.includes(topic)) throw new Error(`KAFKA_TOPIC_MISSING:${topic}`);
    }
  } catch (error) {
    await producer.disconnect();
    try {
      await admin.disconnect();
    } catch {
      // Admin may not have completed its connection.
    }
    throw error;
  }

  const publisher = new KafkaEventPublisher({
    async send(input) {
      await producer.send(input as ProducerRecord);
    },
  });

  return {
    publisher,
    async ping() {
      const topics = await admin.listTopics();
      for (const topic of TOPICS) {
        if (!topics.includes(topic)) throw new Error(`KAFKA_TOPIC_MISSING:${topic}`);
      }
    },
    async close() {
      await Promise.allSettled([producer.disconnect(), admin.disconnect()]);
    },
  };
}
