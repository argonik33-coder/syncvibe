const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const rooms = new Map();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// API ENDPOINT - /api/gemini
app.post('/api/gemini', async (req, res) => {
    const { question } = req.body;
    
    if (!GEMINI_API_KEY) {
        return res.status(500).json({
            reply: '❌ GEMINI_API_KEY yapılandırılmamış.',
            error: true
        });
    }

    try {
        // DÜZELTİLEN KISIM: 'gemini-pro' ve 'v1beta' kullanılıyor.
        // Bu kombinasyon en stabil olanıdır.
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: question }] }],
                    generationConfig: { maxOutputTokens: 1000, temperature: 0.7 }
                })
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Google API Hatası Detayı:', errorText);
            throw new Error(`API Hatası: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Yanıt alınamadı.';
        res.json({ reply });
    } catch (error) {
        console.error('Gemini AI İşlem Hatası:', error.message);
        res.status(500).json({ 
            reply: '❌ AI şu anda yanıt veremiyor. (Model erişim hatası olabilir)',
            error: true 
        });
    }
});

// Socket.IO
io.on('connection', (socket) => {
    console.log(`✅ Kullanıcı bağlandı: ${socket.id}`);

    socket.on('join-room', ({ roomId, username }) => {
        socket.join(roomId);
        
        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                participants: new Map(),
                admin: socket.id,
                botActive: true
            });
        }

        const room = rooms.get(roomId);
        
        room.participants.set(socket.id, {
            id: socket.id,
            username,
            isAdmin: room.admin === socket.id,
            isMuted: false,
            isVideoOff: false,
            isScreenSharing: false
        });

        // WEBBER AI KARŞILAMA
        setTimeout(() => {
            socket.emit('new-message', {
                username: 'Webber AI',
                message: `Merhaba ${username}! Benimle konuşmak isterseniz "/webber [soru]" şeklinde soru sorabilirsiniz. İyi eğlenceler... ♥`,
                timestamp: new Date().toISOString(),
                isBot: true,
                isSystemLog: false
            });
        }, 1000);

        // GİRİŞ LOGU - WEBBER AI
        io.to(roomId).emit('new-message', {
            username: 'Webber AI',
            message: `${username} odaya katıldı`,
            timestamp: new Date().toISOString(),
            isBot: true,
            isSystemLog: true
        });

        socket.to(roomId).emit('user-joined', {
            id: socket.id,
            username,
            isAdmin: room.admin === socket.id
        });

        socket.emit('room-data', {
            participants: Array.from(room.participants.values()),
            admin: room.admin,
            roomId
        });

        console.log(`📥 ${username} katıldı (${roomId})`);
    });

    socket.on('offer', ({ offer, to }) => {
        socket.to(to).emit('offer', { offer, from: socket.id });
    });

    socket.on('answer', ({ answer, to }) => {
        socket.to(to).emit('answer', { answer, from: socket.id });
    });

    socket.on('ice-candidate', ({ candidate, to }) => {
        socket.to(to).emit('ice-candidate', { candidate, from: socket.id });
    });

    socket.on('media-state-change', ({ isMuted, isVideoOff }) => {
        const room = getRoomBySocket(socket.id);
        if (room) {
            const participant = room.participants.get(socket.id);
            if (participant) {
                participant.isMuted = isMuted;
                participant.isVideoOff = isVideoOff;
            }
            socket.to([...room.participants.keys()]).emit('user-media-state', {
                userId: socket.id,
                isMuted,
                isVideoOff
            });
        }
    });

    socket.on('screen-share-state', (isSharing) => {
        const room = getRoomBySocket(socket.id);
        if (room) {
            const participant = room.participants.get(socket.id);
            if (participant) participant.isScreenSharing = isSharing;
            socket.to([...room.participants.keys()]).emit('user-screen-share', {
                userId: socket.id,
                isSharing
            });
        }
    });

    socket.on('send-message', (message) => {
        const room = getRoomBySocket(socket.id);
        if (!room) return;

        const participant = room.participants.get(socket.id);
        
        io.to([...room.participants.keys()]).emit('new-message', {
            username: participant.username,
            message,
            timestamp: new Date().toISOString(),
            isBot: false,
            isSystemLog: false
        });

        // WEBBER AI KOMUTU
        if (message.trim().startsWith('/webber ')) {
            const question = message.substring(8).trim();
            
            if (question) {
                io.to(socket.id).emit('new-message', {
                    username: 'Webber AI',
                    message: '... yanıt hazırlanıyor',
                    timestamp: new Date().toISOString(),
                    isBot: true,
                    isSystemLog: false
                });

                // Dahili fetch
                fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/gemini', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ question })
                })
                .then(res => res.json())
                .then(data => {
                    io.to([...room.participants.keys()]).emit('new-message', {
                        username: 'Webber AI',
                        message: data.reply,
                        timestamp: new Date().toISOString(),
                        isBot: true,
                        isSystemLog: false
                    });
                })
                .catch(err => {
                    console.error('Gemini socket fetch hatası:', err);
                    io.to([...room.participants.keys()]).emit('new-message', {
                        username: 'Webber AI',
                        message: '❌ AI yanıtı alınamadı.',
                        timestamp: new Date().toISOString(),
                        isBot: true,
                        isSystemLog: false
                    });
                });
            }
        }
        else if (room.botActive) {
            const msgLower = message.toLowerCase();
            if (msgLower.includes('katılımcı')) {
                setTimeout(() => {
                    io.to([...room.participants.keys()]).emit('new-message', {
                        username: 'Webber AI',
                        message: `Toplam ${room.participants.size} katılımcı var 👥`,
                        timestamp: new Date().toISOString(),
                        isBot: true,
                        isSystemLog: false
                    });
                }, 500 + Math.random() * 1000);
            }
        }
    });

    socket.on('leave-room', () => handleLeaveRoom(socket));
    
    socket.on('disconnect', () => {
        console.log(`❌ Kullanıcı ayrıldı: ${socket.id}`);
        handleLeaveRoom(socket);
    });
});

function getRoomBySocket(socketId) {
    for (const room of rooms.values()) {
        if (room.participants.has(socketId)) return room;
    }
    return null;
}

function handleLeaveRoom(socket) {
    rooms.forEach((room, roomId) => {
        if (room.participants.has(socket.id)) {
            const participant = room.participants.get(socket.id);
            room.participants.delete(socket.id);
            
            io.to(roomId).emit('new-message', {
                username: 'Webber AI',
                message: `${participant.username} odadan ayrıldı`,
                timestamp: new Date().toISOString(),
                isBot: true,
                isSystemLog: true
            });

            if (room.admin === socket.id && room.participants.size > 0) {
                const newAdmin = room.participants.values().next().value;
                room.admin = newAdmin.id;
                io.to(newAdmin.id).emit('admin-assigned', true);
            }

            io.to(roomId).emit('user-left', socket.id);
            socket.leave(roomId);

            if (room.participants.size === 0) {
                rooms.delete(roomId);
                console.log(`🗑️ Boş oda silindi: ${roomId}`);
            }
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server çalışıyor: http://localhost:${PORT}`);
    console.log(`🤖 Webber AI entegrasyonu aktif: ${GEMINI_API_KEY ? '✅' : '❌'}`);
});