const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const Room = require('../../models/Room');
const User = require('../../models/User');
const { rateLimit } = require('express-rate-limit');
const { redisMaster, getReadRedis } = require('../../utils/redisClient');
const crypto = require('crypto');
let io;

// 속도 제한 설정
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1분
  max: 60, // IP당 최대 요청 수
  message: {
    success: false,
    error: {
      message: '너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.',
      code: 'TOO_MANY_REQUESTS'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Socket.IO 초기화 함수
const initializeSocket = (socketIO) => {
  io = socketIO;
};

// 서버 상태 확인
router.get('/health', async (req, res) => {
  try {
    const isMongoConnected = require('mongoose').connection.readyState === 1;
    const recentRoom = await Room.findOne()
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    const start = process.hrtime();
    await Room.findOne().select('_id').lean();
    const [seconds, nanoseconds] = process.hrtime(start);
    const latency = Math.round((seconds * 1000) + (nanoseconds / 1000000));

    const status = {
      success: true,
      timestamp: new Date().toISOString(),
      services: {
        database: {
          connected: isMongoConnected,
          latency
        }
      },
      lastActivity: recentRoom?.createdAt
    };

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.status(isMongoConnected ? 200 : 503).json(status);

  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      success: false,
      error: {
        message: '서비스 상태 확인에 실패했습니다.',
        code: 'HEALTH_CHECK_FAILED'
      }
    });
  }
});

// 채팅방 목록 조회 (페이징 적용)
router.get('/', [limiter, auth], async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize) || 10), 50);
    const skip = page * pageSize;

    const allowedSortFields = ['createdAt', 'name', 'participantsCount'];
    const sortField = allowedSortFields.includes(req.query.sortField) ? req.query.sortField : 'createdAt';
    const sortOrder = ['asc', 'desc'].includes(req.query.sortOrder) ? req.query.sortOrder : 'desc';

    const filter = {};
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: 'i' };
    }

    const stableStringify = (obj) =>
      JSON.stringify(Object.keys(obj).sort().reduce((acc, key) => {
        acc[key] = obj[key];
        return acc;
      }, {}));
    
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const rawQuery = {
      page,
      pageSize,
      sortField,
      sortOrder,
      search
    };
    const queryHash = crypto.createHash('md5').update(stableStringify(rawQuery)).digest('hex');
    const cacheKey = `chat:room:list:${req.user.id}:${queryHash}`;
    const redis = getReadRedis();
    console.log('[CACHE] rawQuery:', rawQuery);
    console.log('[CACHE] cacheKey:', cacheKey);
    console.log('[CACHE] redis get:', await redis.get(cacheKey));
    // 캐시 조회
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log("방목록 캐시 히트");
      const parsed = JSON.parse(cached);
      res.set({
        'X-Cache-Hit': 'true',
        'Cache-Control': 'private, max-age=10',
        'Last-Modified': new Date().toUTCString()
      });
      return res.json(parsed);
    }

    // 캐시 miss 시 DB 조회
    const totalCount = await Room.countDocuments(filter);

    const rooms = await Room.find(filter)
      .populate('creator', 'name email')
      .populate('participants', 'name email')
      .sort({ [sortField]: sortOrder === 'desc' ? -1 : 1 })
      .skip(skip)
      .limit(pageSize)
      .lean();

    const safeRooms = rooms.map(room => {
      if (!room) return null;
      const creator = room.creator || { _id: 'unknown', name: '알 수 없음', email: '' };
      const participants = Array.isArray(room.participants) ? room.participants : [];

      return {
        _id: room._id?.toString() || 'unknown',
        name: room.name || '제목 없음',
        hasPassword: !!room.hasPassword,
        creator: {
          _id: creator._id?.toString() || 'unknown',
          name: creator.name || '알 수 없음',
          email: creator.email || ''
        },
        participants: participants.filter(p => p && p._id).map(p => ({
          _id: p._id.toString(),
          name: p.name || '알 수 없음',
          email: p.email || ''
        })),
        participantsCount: participants.length,
        createdAt: room.createdAt || new Date(),
        isCreator: creator._id?.toString() === req.user.id,
      };
    }).filter(room => room !== null);

    const totalPages = Math.ceil(totalCount / pageSize);
    const hasMore = skip + rooms.length < totalCount;

    const responsePayload = {
      success: true,
      data: safeRooms,
      metadata: {
        total: totalCount,
        page,
        pageSize,
        totalPages,
        hasMore,
        currentCount: safeRooms.length,
        sort: {
          field: sortField,
          order: sortOrder
        }
      }
    };

    // 캐시 저장
    await redisMaster.set(cacheKey, JSON.stringify(responsePayload), 'EX', 10);
    console.log("캐시 저장됨");
    res.set({
      'X-Cache-Hit': 'false',
      'Cache-Control': 'private, max-age=10',
      'Last-Modified': new Date().toUTCString()
    });

    res.json(responsePayload);
  } catch (error) {
    console.error('방 목록 조회 에러:', error);
    const errorResponse = {
      success: false,
      error: {
        message: '채팅방 목록을 불러오는데 실패했습니다.',
        code: 'ROOMS_FETCH_ERROR'
      }
    };

    if (process.env.NODE_ENV === 'development') {
      errorResponse.error.details = error.message;
      errorResponse.error.stack = error.stack;
    }

    res.status(500).json(errorResponse);
  }
});

// 채팅방 생성
router.post('/', auth, async (req, res) => {
  try {
    const { name, password } = req.body;
    
    if (!name?.trim()) {
      return res.status(400).json({ 
        success: false,
        message: '방 이름은 필수입니다.' 
      });
    }

    const newRoom = new Room({
      name: name.trim(),
      creator: req.user.id,
      participants: [req.user.id],
      password: password
    });

    const savedRoom = await newRoom.save();
    await redisMaster.keys(`chat:room:list:${req.user.id}:*`).then(keys => {
      if (keys.length > 0) {
        redisMaster.del(...keys);
      }
    });
    const room = await Room.findById(savedRoom._id).lean();
    const [creator, participants] = await Promise.all([
      User.findById(room.creator).select('name email').lean(),
      User.find({ _id: { $in: room.participants } }).select('name email').lean()
    ]);

    room.creator = creator;
    room.participants = participants;
    
    // Socket.IO를 통해 새 채팅방 생성 알림
    setImmediate(() => {
      if (io) {
        io.to('room-list').emit('roomCreated', {
          _id: room._id.toString(),
          name: room.name,
          createdAt: room.createdAt
        });
      }
    });
    
    res.status(201).json({
      success: true,
      data: {
        ...room,
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 생성 에러:', error);
    res.status(500).json({ 
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message 
    });
  }
});

// 특정 채팅방 조회
router.get('/:roomId', auth, async (req, res) => {
  try {
    const room = await Room.findById(req.params.roomId)
      .populate('creator', 'name email')
      .populate('participants', 'name email');

    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    res.json({
      success: true,
      data: {
        ...room.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('Room fetch error:', error);
    res.status(500).json({
      success: false,
      message: '채팅방 정보를 불러오는데 실패했습니다.'
    });
  }
});

// 채팅방 입장
router.post('/:roomId/join', auth, async (req, res) => {
  try {
    const { password } = req.body;
    const room = await Room.findById(req.params.roomId).select('+password');
    
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    // 비밀번호 확인
    if (room.hasPassword) {
      const isPasswordValid = await room.checkPassword(password);
      if (!isPasswordValid) {
        return res.status(403).json({
          success: false,
          message: '비밀번호가 일치하지 않습니다.'
        });
      }
    }

    // 참여자 목록에 추가
    if (!room.participants.includes(req.user.id)) {
      room.participants.push(req.user.id);
      await room.save();
      await redisMaster.keys(`chat:room:list:${req.user.id}:*`).then(keys => {
        if (keys.length > 0) {
          redisMaster.del(...keys);
        }
      });
    }

    const populatedRoom = await room.populate('participants', 'name email');

    // Socket.IO를 통해 참여자 업데이트 알림
    if (io) {
      io.to(req.params.roomId).emit('roomUpdate', {
        ...populatedRoom.toObject(),
        password: undefined
      });
    }

    res.json({
      success: true,
      data: {
        ...populatedRoom.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 입장 에러:', error);
    res.status(500).json({
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message
    });
  }
});

module.exports = {
  router,
  initializeSocket
};