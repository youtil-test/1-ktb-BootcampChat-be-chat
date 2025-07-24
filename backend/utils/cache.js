const {redisClient} =require('../utils/redisClient')

const getParticipantsCacheKey = (roomId) => `chat:participants:${roomId}`;

const getCachedParticipants = async (roomId) => {
    const key = getParticipantsCacheKey(roomId);
    const cached = await redisClient.get(key);
  
    
  
    // 이미 JSON.parse된 객체일 수도 있음
    if (!cached) return null;
  
    let parsed = null;
    try {
      parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
    } catch (e) {
      console.error('[Redis GET parse error]', e);
    }
  
    return parsed;
  };

const setCachedParticipants = async (roomId, participants, ttl = 60) => {
    const key = getParticipantsCacheKey(roomId);
    const value = JSON.stringify(participants);
    
  
    await redisClient.set(key, value);          // 먼저 저장하고
    await redisClient.expire(key, ttl);
  };

const invalidateParticipantsCache = async (roomId) => {
  const key = getParticipantsCacheKey(roomId);
  await redisClient.del(key);
};

module.exports = {
  getCachedParticipants,
  setCachedParticipants,
  invalidateParticipantsCache,
};