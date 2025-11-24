// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// /public klasörünü statik olarak sun
app.use(express.static(path.join(__dirname, 'public')));

// Kök URL -> index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Kullanıcıları takip etmek için: socket.id -> { name, room }
const users = {};

// Mesaj geçmişi: room -> [ { user, text, time, from } ]
const roomMessages = {};

function getUsersInRoom(room) {
  return Object.entries(users)
    .filter(([, u]) => u.room === room)
    .map(([id, u]) => ({ id, name: u.name }));
}

function getRoomHistory(room) {
  return roomMessages[room] || [];
}

io.on('connection', (socket) => {
  console.log('Yeni bağlantı:', socket.id);

  // Odaya/kanala katılma
  socket.on('joinRoom', (payload) => {
    let room, user;

    if (typeof payload === 'string') {
      room = payload;
      user = 'Misafir';
    } else if (payload && typeof payload === 'object') {
      room = payload.room;
      user = payload.user || 'Misafir';
    }

    if (!room) return;

    const prevRoom = socket.roomName;
    const prevUser = users[socket.id];

    // Eski odadan çık
    if (prevRoom) {
      socket.leave(prevRoom);
    }

    // Yeni odaya gir
    socket.join(room);
    socket.roomName = room;

    // Kullanıcı kaydı
    if (!users[socket.id]) {
      users[socket.id] = { name: user, room };
    } else {
      users[socket.id].name = user;
      users[socket.id].room = room;
    }

    // Eski odanın kullanıcı listesini güncelle + peer-left + sistem mesajı
    if (prevRoom && prevRoom !== room) {
      const prevUsers = getUsersInRoom(prevRoom);
      io.to(prevRoom).emit('roomUsers', { room: prevRoom, users: prevUsers });

      // WebRTC için ayrılan peer
      socket.to(prevRoom).emit('peer-left', { id: socket.id });

      // Sistem mesajı
      io.to(prevRoom).emit('systemMessage', {
        room: prevRoom,
        text: `${(prevUser && prevUser.name) || 'Bir kullanıcı'} kanaldan ayrıldı`,
        time: new Date().toISOString()
      });
    }

    // Yeni odanın kullanıcı listesini gönder
    const roomUsers = getUsersInRoom(room);
    io.to(room).emit('roomUsers', { room, users: roomUsers });

    // Bu kullanıcıya oda mesaj geçmişini gönder
    const history = getRoomHistory(room);
    socket.emit('roomHistory', { room, messages: history });

    // Diğer kullanıcılara sistem mesajı: kanala katıldı
    socket.to(room).emit('systemMessage', {
      room,
      text: `${user} kanala katıldı`,
      time: new Date().toISOString()
    });

    console.log(`${socket.id} odaya katıldı: ${room} (${user})`);
  });

  // Yazılı sohbet mesajı
  socket.on('chatMessage', ({ room, user, text }) => {
    if (!room || !text) return;

    const msg = {
      user,
      text,
      time: new Date().toISOString(),
      from: socket.id
    };

    if (!roomMessages[room]) {
      roomMessages[room] = [];
    }
    roomMessages[room].push(msg);

    if (roomMessages[room].length > 100) {
      roomMessages[room].shift();
    }

    console.log(`[${room}] ${user}: ${text}`);

    io.to(room).emit('chatMessage', msg);
  });

  // Yazıyor / typing
  socket.on('typing', ({ room, user }) => {
    if (!room) return;
    socket.to(room).emit('typing', { room, user: user || 'Misafir' });
  });

  socket.on('stopTyping', ({ room, user }) => {
    if (!room) return;
    socket.to(room).emit('stopTyping', { room, user: user || 'Misafir' });
  });

  // WebRTC: Çoklu katılımcı için to/from bazlı sinyalleme

  // OFFER: { room, to, from, offer, hasVideo }
  socket.on('webrtc-offer', ({ room, to, offer, hasVideo }) => {
    if (!room || !offer || !to) return;
    io.to(to).emit('webrtc-offer', {
      room,
      from: socket.id,
      offer,
      hasVideo
    });
  });

  // ANSWER: { room, to, from, answer }
  socket.on('webrtc-answer', ({ room, to, answer }) => {
    if (!room || !answer || !to) return;
    io.to(to).emit('webrtc-answer', {
      room,
      from: socket.id,
      answer
    });
  });

  // ICE CANDIDATE: { room, to, from, candidate }
  socket.on('webrtc-ice-candidate', ({ room, to, candidate }) => {
    if (!room || !candidate || !to) return;
    io.to(to).emit('webrtc-ice-candidate', {
      room,
      from: socket.id,
      candidate
    });
  });

  // Bağlantı koptuğunda
  socket.on('disconnect', () => {
    console.log('Bağlantı koptu:', socket.id);
    const user = users[socket.id];
    if (user) {
      const room = user.room;
      delete users[socket.id];

      const roomUsers = getUsersInRoom(room);
      io.to(room).emit('roomUsers', { room, users: roomUsers });

      // WebRTC peer'lere bildir
      socket.to(room).emit('peer-left', { id: socket.id });

      // Sistem mesajı
      io.to(room).emit('systemMessage', {
        room,
        text: `${user.name || 'Bir kullanıcı'} odadan ayrıldı`,
        time: new Date().toISOString()
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SyncVibe sunucu çalışıyor: http://localhost:${PORT}`);
});