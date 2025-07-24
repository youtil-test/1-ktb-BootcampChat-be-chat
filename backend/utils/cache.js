const { redisMaster, getReadRedis } = require('../utils/redisClient');

const getParticipantsCacheKey = (roomId) => `chat:participants:${roomId}`;

const getCachedParticipants = async (roomId) => {
  const key = getParticipantsCacheKey(roomId);
  const redis = getReadRedis();

  const cached = await redis.get(key);
  if (!cached) return null;

  try {
    console.log("캐시히트");
    return typeof cached === 'string' ? JSON.parse(cached) : cached;
  } catch (e) {
    console.error('[Redis GET parse error]', e);
    return null;
  }
};

const setCachedParticipants = async (roomId, participants, ttl = 60) => {
  const key = getParticipantsCacheKey(roomId);
  const value = JSON.stringify(participants);
  
  // ioredis에서 TTL 지정 시 'EX'를 명시해야 함
  await redisMaster.set(key, value, 'EX', ttl);
};

const invalidateParticipantsCache = async (roomId) => {
  const key = getParticipantsCacheKey(roomId);
  await redisMaster.del(key);
};

module.exports = {
  getCachedParticipants,
  setCachedParticipants,
  invalidateParticipantsCache,
};