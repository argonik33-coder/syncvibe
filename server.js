// server.js - Render için güncellendi
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const sanitizeHtml = require('sanitize-html');
const winston = require('winston');

// Render-specific configuration
const isProduction = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

// Logger konfigürasyonu
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

const app = express();
const server = http.createServer(app);

// Socket.io konfigürasyonu - Render için optimize
const io = socketIo(server, {
  cors: {
    origin: isProduction ? false : "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'] // Render için gerekli
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Çok fazla istek gönderdiniz. Lütfen daha sonra tekrar deneyin.'
  }
});

// Middleware'ler
app.use(helmet({
  contentSecurityPolicy: false, // Render için CSP devre dışı
  crossOriginEmbedderPolicy: false
}));

app.use(cors());
app.use(limiter);
app.use(express.json({ limit: '10kb' }));

// Static files - Render için public klasörü
app.use(express.static(path.join(__dirname, 'public')));

// Ana sayfa route'u
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Oda sayfası route'u
app.get('/room.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// API Routes
app.get('/api/status', (req, res) => {
  const activeRooms = Array.from(rooms.values()).filter(room => room.users.length > 0);
  
  res.json({
    status: 'active',
    roomCount: activeRooms.length,
    totalUsers: activeRooms.reduce((acc, room) => acc + room.users.length, 0),
    totalConnections: userSessions.size,
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Config değişkenleri
const config = {
  rooms: {
    maxUsers: parseInt(process.env.MAX_USERS_PER_ROOM) || 10,
    codeLength: 6,
    inactiveTimeout: 2 * 60 * 60 * 1000,
    maxMessageLength: 500,
    maxUsernameLength: 20
  },
  security: {
    socketRateLimit: {
      maxEventsPerMinute: 60
    }
  }
};

// Doğrulama fonksiyonları (önceki kodun aynısı)
const validateJoinRoom = (data) => {
  const errors = [];
  
  if (!data.roomCode || typeof data.roomCode !== 'string') {
    errors.push('Oda kodu gereklidir');
  } else if (data.roomCode.length !== config.rooms.codeLength) {
    errors.push(`Oda kodu ${config.rooms.codeLength} haneli olmalıdır`);
  } else if (!/^[A-Z0-9]+$/.test(data.roomCode)) {
    errors.push('Oda kodu sadece büyük harf ve rakamlardan oluşabilir');
  }

  if (!data.userName || typeof data.userName !== 'string') {
    errors.push('Kullanıcı adı gereklidir');
  } else {
    const sanitizedUserName = sanitizeHtml(data.userName.trim(), {
      allowedTags: [],
      allowedAttributes: {}
    });
    
    if (sanitizedUserName.length === 0) {
      errors.push('Geçersiz kullanıcı adı');
    } else if (sanitizedUserName.length > config.rooms.maxUsernameLength) {
      errors.push(`Kullanıcı adı ${config.rooms.maxUsernameLength} karakteri geçemez`);
    }
  }

  return errors;
};

const validateMessage = (text) => {
  if (!text || typeof text !== 'string') {
    return { isValid: false, error: 'Mesaj gereklidir' };
  }

  const sanitizedText = sanitizeHtml(text.trim(), {
    allowedTags: [],
    allowedAttributes: {},
    allowedIframeHostnames: []
  });

  if (sanitizedText.length === 0) {
    return { isValid: false, error: 'Mesaj boş olamaz' };
  }

  if (sanitizedText.length > config.rooms.maxMessageLength) {
    return { 
      isValid: false, 
      error: `Mesaj ${config.rooms.maxMessageLength} karakteri geçemez` 
    };
  }

  return { isValid: true, sanitizedText };
};

// Oda yönetimi (önceki kodun aynısı)
const rooms = new Map();
const userSessions = new Map();
const socketRateLimitMap = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < config.rooms.codeLength; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateMessageId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function cleanupInactiveRooms() {
  const now = new Date();
  let cleanedCount = 0;

  for (const [roomCode, room] of rooms.entries()) {
    if (room.users.length === 0 && (now - room.lastActivity) > config.rooms.inactiveTimeout) {
      rooms.delete(roomCode);
      cleanedCount++;
      logger.info(`Inaktif oda temizlendi: ${roomCode}`);
    }
  }

  if (cleanedCount > 0) {
    logger.info(`${cleanedCount} inaktif oda temizlendi`);
  }
}

// Socket rate limiting
const checkSocketRateLimit = (socket) => {
  const now = Date.now();
  const windowMs = 60000;
  const maxEvents = config.security.socketRateLimit.maxEventsPerMinute;

  if (!socketRateLimitMap.has(socket.id)) {
    socketRateLimitMap.set(socket.id, {
      count: 1,
      firstEvent: now
    });
    return true;
  }

  const userLimit = socketRateLimitMap.get(socket.id);
  
  if (now - userLimit.firstEvent > windowMs) {
    userLimit.count = 1;
    userLimit.firstEvent = now;
    return true;
  }

  if (userLimit.count >= maxEvents) {
    return false;
  }

  userLimit.count++;
  return true;
};

// Socket.io bağlantıları (önceki kodun aynısı)
io.on('connection', (socket) => {
  logger.info('Yeni kullanıcı bağlandı', { 
    socketId: socket.id, 
    ip: socket.handshake.address 
  });

  userSessions.set(socket.id, {
    id: socket.id,
    connectedAt: new Date(),
    lastActivity: new Date(),
    ip: socket.handshake.address
  });

  // Oda kontrolü
  socket.on('check-room', (roomCode) => {
    if (!checkSocketRateLimit(socket)) {
      socket.emit('error', 'Çok hızlı istek gönderiyorsunuz. Lütfen bekleyin.');
      return;
    }

    userSessions.get(socket.id).lastActivity = new Date();
    
    const validationErrors = validateJoinRoom({ roomCode, userName: 'temp' });
    if (validationErrors.length > 0) {
      socket.emit('error', validationErrors[0]);
      return;
    }

    const room = rooms.get(roomCode.toUpperCase());
    const exists = room !== undefined;
    
    socket.emit('room-exists', { exists: exists });
  });

  // Yeni oda oluşturma
  socket.on('create-room', (userData) => {
    if (!checkSocketRateLimit(socket)) {
      socket.emit('error', 'Çok hızlı istek gönderiyorsunuz. Lütfen bekleyin.');
      return;
    }

    userSessions.get(socket.id).lastActivity = new Date();
    
    const validationErrors = validateJoinRoom({ 
      roomCode: 'TEMPORARY', 
      userName: userData?.name 
    });
    if (validationErrors.length > 0) {
      socket.emit('error', validationErrors[0]);
      return;
    }

    let roomCode;
    let attempts = 0;
    do {
      roomCode = generateRoomCode();
      attempts++;
      if (attempts > 10) {
        logger.error('Oda kodu oluşturma başarısız', { socketId: socket.id });
        socket.emit('error', 'Oda oluşturulamadı. Lütfen tekrar deneyin.');
        return;
      }
    } while (rooms.has(roomCode));

    const createdAt = new Date();
    
    const newRoom = {
      users: [],
      createdAt: createdAt,
      lastActivity: createdAt,
      createdBy: sanitizeHtml(userData.name.trim(), { allowedTags: [], allowedAttributes: {} }),
      createdBySocketId: socket.id,
      settings: {
        maxUsers: config.rooms.maxUsers,
        allowGuests: true,
        requirePassword: false,
        roomType: 'public'
      },
      stats: {
        totalMessages: 0,
        totalUsers: 0
      }
    };
    
    rooms.set(roomCode, newRoom);
    
    logger.info('Yeni oda oluşturuldu', { 
      roomCode, 
      createdBy: newRoom.createdBy,
      socketId: socket.id 
    });
    
    socket.emit('room-created', roomCode);
    updateStats();
  });

  // Odaya katılma
  socket.on('join-room', (data) => {
    if (!checkSocketRateLimit(socket)) {
      socket.emit('error', 'Çok hızlı istek gönderiyorsunuz. Lütfen bekleyin.');
      return;
    }

    userSessions.get(socket.id).lastActivity = new Date();
    
    const validationErrors = validateJoinRoom(data);
    if (validationErrors.length > 0) {
      socket.emit('error', validationErrors[0]);
      return;
    }

    const roomCode = data.roomCode.toUpperCase();
    const userName = sanitizeHtml(data.userName.trim(), { 
      allowedTags: [], 
      allowedAttributes: {} 
    });

    if (!rooms.has(roomCode)) {
      socket.emit('error', 'Oda bulunamadı!');
      return;
    }

    const room = rooms.get(roomCode);
    
    if (room.users.length >= room.settings.maxUsers) {
      socket.emit('error', 'Oda dolu! Maksimum kullanıcı sayısına ulaşıldı.');
      return;
    }

    const existingUser = room.users.find(u => u.id === socket.id);
    if (existingUser) {
      socket.emit('error', 'Zaten bu odadasınız!');
      return;
    }

    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    const user = {
      id: socket.id,
      name: userName,
      joinedAt: new Date(),
      isHost: room.users.length === 0,
      isMuted: false,
      isSpeaking: false,
      lastSeen: new Date()
    };
    
    room.users.push(user);
    room.lastActivity = new Date();
    room.stats.totalUsers++;

    socket.emit('room-joined', {
      roomCode,
      user,
      roomSettings: room.settings,
      roomCreatedAt: room.createdAt,
      participants: room.users
    });
    
    socket.to(roomCode).emit('user-joined', user);
    io.to(roomCode).emit('update-participants', room.users);
    
    io.to(roomCode).emit('new-message', {
      user: 'Sistem',
      text: `${user.name} odaya katıldı`,
      timestamp: new Date().toLocaleTimeString('tr-TR'),
      type: 'system',
      messageId: generateMessageId()
    });
    
    logger.info('Kullanıcı odaya katıldı', {
      roomCode,
      userName: user.name,
      userCount: room.users.length,
      socketId: socket.id
    });
    
    updateStats();
  });

  // Mesaj gönderme
  socket.on('send-message', (messageData) => {
    if (!checkSocketRateLimit(socket)) {
      socket.emit('error', 'Çok hızlı istek gönderiyorsunuz. Lütfen bekleyin.');
      return;
    }

    userSessions.get(socket.id).lastActivity = new Date();
    
    const messageValidation = validateMessage(messageData.text);
    if (!messageValidation.isValid) {
      socket.emit('error', messageValidation.error);
      return;
    }

    if (socket.roomCode && rooms.has(socket.roomCode)) {
      const room = rooms.get(socket.roomCode);
      const user = room.users.find(u => u.id === socket.id);
      
      if (user) {
        const message = {
          user: user.name,
          text: messageValidation.sanitizedText,
          timestamp: new Date().toLocaleTimeString('tr-TR'),
          type: 'user',
          userId: socket.id,
          messageId: generateMessageId(),
          timestampISO: new Date().toISOString()
        };
        
        room.stats.totalMessages++;
        room.lastActivity = new Date();
        
        io.to(socket.roomCode).emit('new-message', message);
        
        logger.info('Yeni mesaj', {
          roomCode: socket.roomCode,
          userName: user.name,
          messageLength: message.text.length,
          socketId: socket.id
        });
      }
    }
  });

  socket.on('disconnect', (reason) => {
    logger.info('Kullanıcı ayrıldı', { 
      socketId: socket.id, 
      reason
    });
    
    if (socket.roomCode && rooms.has(socket.roomCode)) {
      const room = rooms.get(socket.roomCode);
      const userIndex = room.users.findIndex(u => u.id === socket.id);
      
      if (userIndex !== -1) {
        const user = room.users[userIndex];
        room.users.splice(userIndex, 1);
        
        io.to(socket.roomCode).emit('user-left', user);
        io.to(socket.roomCode).emit('update-participants', room.users);
        
        io.to(socket.roomCode).emit('new-message', {
          user: 'Sistem',
          text: `${user.name} odadan ayrıldı`,
          timestamp: new Date().toLocaleTimeString('tr-TR'),
          type: 'system',
          messageId: generateMessageId()
        });
        
        // Oda boşsa temizleme zamanını güncelle
        if (room.users.length === 0) {
          room.lastActivity = new Date();
        }
        
        updateStats();
      }
    }
    
    userSessions.delete(socket.id);
    socketRateLimitMap.delete(socket.id);
  });
});

// Stats güncelleme fonksiyonu
function updateStats() {
  const stats = {
    roomCount: Array.from(rooms.values()).filter(room => room.users.length > 0).length,
    totalUsers: Array.from(rooms.values()).reduce((acc, room) => acc + room.users.length, 0),
    totalConnections: userSessions.size,
    serverTime: new Date().toISOString()
  };
  io.emit('stats-updated', stats);
}

// Temizleme interval'leri
setInterval(cleanupInactiveRooms, 30 * 60 * 1000);
setInterval(() => {
  const now = Date.now();
  for (const [socketId, limit] of socketRateLimitMap.entries()) {
    if (now - limit.firstEvent > 60000) {
      socketRateLimitMap.delete(socketId);
    }
  }
}, 60000);

// Sunucuyu başlat
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`SyncVibe sunucusu Render'da başlatıldı`, {
    port: PORT,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM alındı, sunucu kapatılıyor...');
  server.close(() => {
    logger.info('Sunucu kapatıldı');
    process.exit(0);
  });
});