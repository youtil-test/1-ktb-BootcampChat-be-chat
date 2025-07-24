
const { Kafka } = require('kafkajs');
const kafka = new Kafka({
  clientId: 'chat-backend',
  brokers: ['34.64.53.201:9094'], // 또는 도커 호스트나 클라우드 Kafka 브로커 주소
});

const producer = kafka.producer();

const initProducer = async () => {
  await producer.connect();
};

const publishAIRequest = async ({ roomId, aiType, query, user }) => {
  await producer.send({
    topic: 'ai-requests',
    messages: [
      {
        key: roomId,
        value: JSON.stringify({
          roomId,
          aiType,
          query,
          user, // user.id, user.name, profile 등
          timestamp: new Date().toISOString()
        }),
      },
    ],
  });
};

module.exports = {
  initProducer,
  publishAIRequest,
};