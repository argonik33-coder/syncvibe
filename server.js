// server.js - WEBRTC SİNYAL SUNUCUSU TAMAMEN GÜNCELLENDİ
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');

// Render-specific configuration
const isProduction = process.env.NODE_ENV || 'development';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

// Socket.io konfigürasyonu
const io = socketIo(server, {
  cors: {
    origin: isProduction ? false : "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Çok fazla istek gönderiyorsunuz. Lütfen bekleyin.'
  }
});

// Middleware'ler
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors());
app.use(limiter);
app.use(express.json({ limit: '10kb' }));
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

// Doğrulama fonksiyonları
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

// Oda yönetimi
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

function cleanupInactiveRooms() {
  const now = new Date();
  let cleanedCount = 0;

  for (const [roomCode, room] of rooms.entries()) {
    if (room.users.length === 0 && (now - room.lastActivity) > config.rooms.inactiveTimeout) {
      rooms.delete(roomCode);
      cleanedCount++;
      console.log(`Inaktif oda temizlendi: ${roomCode}`);
    }
  }

  if (cleanedCount > 0) {
    console.log(`${cleanedCount} inaktif oda temizlendi`);
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

// Socket.io bağlantıları
io.on('connection', (socket) => {
  console.log('Yeni kullanıcı bağlandı:', socket.id);

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
    
    if (!userData || !userData.name || typeof userData.name !== 'string') {
      socket.emit('error', 'Kullanıcı adı gereklidir');
      return;
    }

    const sanitizedUserName = sanitizeHtml(userData.name.trim(), {
      allowedTags: [],
      allowedAttributes: {}
    });
    
    if (sanitizedUserName.length === 0) {
      socket.emit('error', 'Geçersiz kullanıcı adı');
      return;
    }
    
    if (sanitizedUserName.length > config.rooms.maxUsernameLength) {
      socket.emit('error', `Kullanıcı adı ${config.rooms.maxUsernameLength} karakteri geçemez`);
      return;
    }

    let roomCode;
    let attempts = 0;
    do {
      roomCode = generateRoomCode();
      attempts++;
      if (attempts > 10) {
        console.error('Oda kodu oluşturma başarısız:', socket.id);
        socket.emit('error', 'Oda oluşturulamadı. Lütfen tekrar deneyin.');
        return;
      }
    } while (rooms.has(roomCode));

    const createdAt = new Date();
    
    const newRoom = {
      users: [],
      createdAt: createdAt,
      lastActivity: createdAt,
      createdBy: sanitizedUserName,
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
    
    console.log('Yeni oda oluşturuldu:', roomCode, 'Oluşturan:', sanitizedUserName);
    
    socket.emit('room-created', roomCode);
    updateStats();
  });

  // Odaya katılma - WEBRTC ENTEGRASYONU EKLENDİ
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
      isMuted: true,
      isSpeaking: false,
      lastSeen: new Date()
    };
    
    room.users.push(user);
    room.lastActivity = new Date();
    room.stats.totalUsers++;

    // Mevcut kullanıcıları yeni kullanıcıya gönder
    const existingUsers = room.users.filter(u => u.id !== socket.id).map(u => ({
      socketId: u.id,
      userName: u.name
    }));

    socket.emit('room-joined', {
      roomCode,
      user,
      roomSettings: room.settings,
      roomCreatedAt: room.createdAt,
      participants: room.users,
      existingUsers: existingUsers
    });
    
    // Yeni kullanıcıyı mevcut kullanıcılara bildir
    socket.to(roomCode).emit('new-user-joined', {
      socketId: socket.id,
      userName: user.name
    });
    
    socket.to(roomCode).emit('user-joined', {
      userName: user.name,
      participants: room.users,
      socketId: socket.id
    });
    
    io.to(roomCode).emit('update-participants', room.users);
    
    socket.to(roomCode).emit('receive-message', {
      userName: 'Sistem',
      message: `${user.name} odaya katıldı`,
      timestamp: new Date().toLocaleTimeString('tr-TR'),
      type: 'system'
    });
    
    console.log('Kullanıcı odaya katıldı:', user.name, 'Oda:', roomCode);
    
    updateStats();
  });

  // Mesaj gönderme
  socket.on('send-message', (messageData) => {
    if (!checkSocketRateLimit(socket)) {
      socket.emit('error', 'Çok hızlı istek gönderiyorsunuz. Lütfen bekleyin.');
      return;
    }

    userSessions.get(socket.id).lastActivity = new Date();
    
    const messageValidation = validateMessage(messageData.message);
    if (!messageValidation.isValid) {
      socket.emit('error', messageValidation.error);
      return;
    }

    if (socket.roomCode && rooms.has(socket.roomCode)) {
      const room = rooms.get(socket.roomCode);
      const user = room.users.find(u => u.id === socket.id);
      
      if (user) {
        const message = {
          userName: user.name,
          message: messageValidation.sanitizedText,
          timestamp: messageData.timestamp || new Date().toLocaleTimeString('tr-TR'),
          type: 'user'
        };
        
        room.stats.totalMessages++;
        room.lastActivity = new Date();
        
        socket.to(socket.roomCode).emit('receive-message', message);
        
        console.log('Yeni mesaj:', user.name, '-', message.message.substring(0, 50));
      }
    }
  });

  // WEBRTC SİNYALLEŞME - TAMAMEN YENİLENDİ
  socket.on('webrtc-offer', (data) => {
    console.log('WebRTC offer alındı:', data.targetSocketId, 'from:', socket.id);
    socket.to(data.targetSocketId).emit('webrtc-offer', {
      offer: data.offer,
      fromSocketId: socket.id,
      userName: data.userName
    });
  });

  socket.on('webrtc-answer', (data) => {
    console.log('WebRTC answer alındı:', data.targetSocketId, 'from:', socket.id);
    socket.to(data.targetSocketId).emit('webrtc-answer', {
      answer: data.answer,
      fromSocketId: socket.id,
      userName: data.userName
    });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    console.log('WebRTC ICE candidate alındı:', data.targetSocketId, 'from:', socket.id);
    socket.to(data.targetSocketId).emit('webrtc-ice-candidate', {
      candidate: data.candidate,
      fromSocketId: socket.id,
      userName: data.userName
    });
  });

  // Medya durumu güncelleme
  socket.on('media-status-update', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('user-media-updated', {
        socketId: socket.id,
        userName: data.userName,
        hasVideo: data.hasVideo,
        hasAudio: data.hasAudio,
        isScreenSharing: data.isScreenSharing
      });
    }
  });

  // Yazıyor indikatörü
  socket.on('typing-start', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('user-typing-start', data);
    }
  });

  socket.on('typing-stop', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('user-typing-stop', data);
    }
  });

  // Ses durumu güncelleme
  socket.on('audio-state-change', (data) => {
    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) {
        const user = room.users.find(u => u.id === socket.id);
        if (user) {
          user.isMuted = data.isMuted;
          io.to(socket.roomCode).emit('update-participants', room.users);
        }
      }
      
      socket.to(socket.roomCode).emit('audio-state-changed', {
        userId: socket.id,
        isMuted: data.isMuted,
        userName: data.userName
      });
    }
  });

  // Ekran paylaşımı
  socket.on('screen-share-started', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('user-screen-sharing', {
        userName: data.userName,
        isSharing: true,
        socketId: socket.id
      });
    }
  });

  socket.on('screen-share-stopped', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('user-screen-sharing', {
        userName: data.userName,
        isSharing: false,
        socketId: socket.id
      });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Kullanıcı ayrıldı:', socket.id, reason);
    
    if (socket.roomCode && rooms.has(socket.roomCode)) {
      const room = rooms.get(socket.roomCode);
      const userIndex = room.users.findIndex(u => u.id === socket.id);
      
      if (userIndex !== -1) {
        const user = room.users[userIndex];
        room.users.splice(userIndex, 1);
        
        // Tüm kullanıcılara ayrılan kullanıcıyı bildir
        socket.to(socket.roomCode).emit('user-disconnected', {
          socketId: socket.id,
          userName: user.name
        });
        
        socket.to(socket.roomCode).emit('user-left', {
          userName: user.name,
          participants: room.users,
          socketId: socket.id
        });
        
        io.to(socket.roomCode).emit('update-participants', room.users);
        
        socket.to(socket.roomCode).emit('receive-message', {
          userName: 'Sistem',
          message: `${user.name} odadan ayrıldı`,
          timestamp: new Date().toLocaleTimeString('tr-TR'),
          type: 'system'
        });
        
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
  console.log(`SyncVibe sunucusu ${PORT} portunda başlatıldı`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM alındı, sunucu kapatılıyor...');
  server.close(() => {
    console.log('Sunucu kapatıldı');
    process.exit(0);
  });
});