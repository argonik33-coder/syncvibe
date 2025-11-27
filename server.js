const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Gemini API Key - .env dosyasından alınacak
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.warn('\n⚠️  UYARI: GEMINI_API_KEY bulunamadı!');
    console.warn('   Lütfen .env dosyası oluşturun ve GEMINI_API_KEY=your_key_here ekleyin.\n');
}

const rooms = new Map();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// Gemini API Endpoint
app.post('/api/gemini', async (req, res) => {
    const { question } = req.body;
    
    if (!GEMINI_API_KEY) {
        return res.status(500).json({
            reply: '❌ GEMINI_API_KEY yapılandırılmamış. Lütfen .env dosyası oluşturun.',
            error: true
        });
    }

    try {
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

        const data = await response.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Yanıt alınamadı.';
        res.json({ reply });
    } catch (error) {
        console.error('Gemini AI Hatası:', error.message);
        res.status(500).json({ 
            reply: '❌ AI yanıtı alınamadı. API anahtarınızı kontrol edin.',
            error: true 
        });
    }
});

// Socket.IO
io.on('connection', (socket) => {
    console.log(`✅ Kullanıcı bağlandı: ${socket.id}`);

    socket.on('join-room', ({ roomId, username, isAdmin }) => {
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
            isMuted: true,
            isVideoOff: false,
            isScreenSharing: false
        });

        // Webber AI karşılama
        setTimeout(() => {
            socket.emit('new-message', {
                username: 'Webber AI',
                message: `Merhaba ${username}! Benimle konuşmak için "/webber [soru]" yazın. İyi eğlenceler! ♥`,
                isBot: true,
                isSystemLog: false
            });
        }, 1000);

        // Giriş logu
        io.to(roomId).emit('new-message', {
            username: 'Webber AI',
            message: `${username} odaya katıldı`,
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
            admin: room.admin
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
            isBot: false,
            isSystemLog: false
        });

        // Webber AI komutu
        if (message.trim().startsWith('/webber ')) {
            const question = message.substring(8).trim();
            
            if (question) {
                io.to(socket.id).emit('new-message', {
                    username: 'Webber AI',
                    message: '... yanıt hazırlanıyor',
                    isBot: true,
                    isSystemLog: false
                });

                const protocol = req.protocol || 'http';
                const host = req.get('host') || `localhost:${process.env.PORT || 3000}`;
                
                fetch(`${protocol}://${host}/api/gemini`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ question })
                })
                .then(res => res.json())
                .then(data => {
                    io.to([...room.participants.keys()]).emit('new-message', {
                        username: 'Webber AI',
                        message: data.reply,
                        isBot: true,
                        isSystemLog: false
                    });
                })
                .catch(err => {
                    console.error('Gemini fetch hatası:', err);
                    io.to([...room.participants.keys()]).emit('new-message', {
                        username: 'Webber AI',
                        message: '❌ AI yanıtı alınamadı.',
                        isBot: true,
                        isSystemLog: false
                    });
                });
            }
        }
    });

    socket.on('leave-room', () => handleLeaveRoom(socket));
    socket.on('disconnect', () => handleLeaveRoom(socket));
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
    console.log(`\n🚀 Server çalışıyor: http://localhost:${PORT}`);
    console.log(`🤖 Gemini API: ${GEMINI_API_KEY ? '✅ Aktif' : '❌ Eksik (.env dosyası oluşturun)'}\n`);
});