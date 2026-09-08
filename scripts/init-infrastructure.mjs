import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const port = process.env.RABBITMQ_MANAGEMENT_PORT || '15672';
if (!/^\d{1,5}$/.test(port)) throw new Error('Invalid management port');
const credentials = Buffer.from(`${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}`).toString('base64');
const response = await fetch(`http://127.0.0.1:${port}/api/definitions`, {
  method: 'POST', headers: {'authorization':`Basic ${credentials}`, 'content-type':'application/json'},
  body: await readFile(new URL('../infrastructure/rabbitmq/definitions.json',import.meta.url),'utf8'), signal: AbortSignal.timeout(10000)
});
if (!response.ok) throw new Error(`RabbitMQ topology failed: HTTP ${response.status}`);
console.log('RabbitMQ command and dead-letter topology applied.');
if (process.argv.includes('--kafka')) {
  for (const topic of ['site.lifecycle.v1','content.changed.v1','integration.status.v1','usage.observed.v1']) {
    const result = spawnSync('docker',['compose','exec','-T','kafka','/opt/kafka/bin/kafka-topics.sh','--bootstrap-server','kafka:9092','--create','--if-not-exists','--topic',topic,'--partitions','3','--replication-factor','1','--config','min.insync.replicas=1'], {stdio:'inherit', timeout:60000});
    if (result.status !== 0) throw new Error(`Kafka topic initialization failed: ${topic}`);
  }
}
