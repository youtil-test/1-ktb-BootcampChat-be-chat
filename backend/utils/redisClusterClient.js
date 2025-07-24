const Redis = require('ioredis');

// ✅ 쓰기용 (마스터 전용)
const redisMaster = new Redis({
  host: '3.36.91.119',
  port: 6379,// 생략 가능
  connectTimeout: 5000,
  retryStrategy: times => Math.min(times * 100, 3000),
});

// ✅ 읽기용 (레플리카들)
const redisSlaves = [
  new Redis({ host: '3.36.87.186', port: 6379, connectTimeout: 5000 }),
  new Redis({ host: '3.34.191.158', port: 6379, connectTimeout: 5000 }),
];

// ✅ 라운드 로빈 읽기 선택자
let currentSlave = 0;
function getReadRedis() {
  const redis = redisSlaves[currentSlave];
  currentSlave = (currentSlave + 1) % redisSlaves.length;
  return redis;
}
function getRedisCluster() {
    return redisMaster;
  }
// ✅ Pub/Sub용 클라이언트 (마스터에 붙이는 게 안정적)
const pubClient = new Redis({
  host: '3.36.91.119',
  port: 6379,
  connectTimeout: 5000,
});

const subClient = new Redis({
  host: '3.36.91.119',
  port: 6379,
  connectTimeout: 5000,
});

// ✅ 이벤트 로깅
[redisMaster, ...redisSlaves, pubClient, subClient].forEach((client, idx) => {
  client.on('connect', () => console.log(`[Redis] Client ${idx} connected`));
  client.on('error', err => console.error(`[Redis] Client ${idx} error:`, err.message));
});

// ✅ export
module.exports = {
  redisMaster,
  getReadRedis,
  pubClient,
  subClient,
  getRedisCluster
};