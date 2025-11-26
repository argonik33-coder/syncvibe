/**
 * VibeZone - WebRTC Signaling Server
 * by YavuzSOFT
 */

const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const url = require('url'); // <-- EKLENDİ

const PORT = process.env.PORT || 3000;
const MAX_ROOM_SIZE = 12;

// ═══════════════════════════════════════════════════════════════
// HTTP SUNUCUSU
// ═══════════════════════════════════════════════════════════════

const server = http.createServer((req, res) => {
    // URL'yi parse et (query string'i ayır)
    const parsedUrl = url.parse(req.url, true);
    let pathname = parsedUrl.pathname;
    
    // Güvenlik: path traversal saldırılarını önle
    pathname = pathname.replace(/\.\./g, '');
    
    // Dosya yolunu belirle
    let filePath = '.' + pathname;
    if (filePath === './' || filePath === '.') {
        filePath = './index.html';
    }
    
    // Debug: Hangi dosya isteniyor?
    console.log(`[HTTP] İstek: ${req.url} → Dosya: ${filePath}`);
    
    // Dosya uzantısını al
    const extname = path.extname(filePath).toLowerCase();
    
    // MIME types
    const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.webp': 'image/webp',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm'
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    // Dosya var mı kontrol et
    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            console.log(`[HTTP] 404 - Dosya bulunamadı: ${filePath}`);
            
            // Mevcut dosyaları listele (debug için)
            fs.readdir('.', (err, files) => {
                if (!err) {
                    console.log(`[HTTP] Mevcut dosyalar: ${files.join(', ')}`);
                }
            });
            
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <!DOCTYPE html>
                <html>
                <head><title>404 - Dosya Bulunamadı</title></head>
                <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h1>404 - Dosya Bulunamadı</h1>
                    <p>İstenen dosya: <code>${filePath}</code></p>
                    <p><a href="/">Ana Sayfaya Dön</a></p>
                </body>
                </html>
            `);
            return;
        }

        // Dosyayı oku ve gönder
        fs.readFile(filePath, (error, content) => {
            if (error) {
                console.error(`[HTTP] Dosya okuma hatası: ${error.message}`);
                res.writeHead(500);
                res.end('Sunucu hatası: ' + error.code);
            } else {
                console.log(`[HTTP] 200 - Gönderiliyor: ${filePath}`);
                res.writeHead(200, { 
                    'Content-Type': contentType,
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(content, 'utf-8');
            }
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET SUNUCUSU
// ═══════════════════════════════════════════════════════════════

const wss = new WebSocket.Server({ server });
const rooms = new Map();

function generateClientId() {
    return 'user_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36);
}

function broadcastToRoom(roomCode, message, excludeClientId = null) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const messageStr = JSON.stringify(message);
    room.clients.forEach((client, id) => {
        if (id !== excludeClientId && client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.send(messageStr);
            } catch (err) {
                console.error(`[HATA] Mesaj gönderilemedi:`, err.message);
            }
        }
    });
}

function sendToClient(roomCode, clientId, message) {
    const room = rooms.get(roomCode);
    if (!room) return false;
    const client = room.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
        try {
            client.ws.send(JSON.stringify(message));
            return true;
        } catch (err) {
            console.error(`[HATA] Mesaj gönderilemedi:`, err.message);
        }
    }
    return false;
}

function logRoomStats() {
    console.log(`\n[İSTATİSTİK] Aktif oda sayısı: ${rooms.size}`);
    rooms.forEach((room, code) => {
        console.log(`  └─ Oda #${code}: ${room.clients.size} katılımcı`);
    });
}

wss.on('connection', (ws, req) => {
    let clientId = null;
    let currentRoom = null;
    let clientName = 'Misafir';

    console.log(`[WS] Yeni bağlantı`);

    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (e) {
            console.error('[HATA] Geçersiz JSON');
            return;
        }

        switch (msg.type) {
            case 'join':
                handleJoin(msg);
                break;
            case 'signal':
                handleSignal(msg);
                break;
            case 'chat':
                handleChat(msg);
                break;
            case 'status':
                handleStatus(msg);
                break;
            case 'reaction':
                handleReaction(msg);
                break;
            case 'control':
                handleControl(msg);
                break;
        }
    });

    function handleJoin(msg) {
        const { room: roomCode, name } = msg;
        
        if (!roomCode) {
            ws.send(JSON.stringify({ type: 'error', message: 'Geçersiz oda kodu' }));
            return;
        }

        clientId = generateClientId();
        currentRoom = roomCode;
        clientName = name || 'Misafir';

        if (!rooms.has(roomCode)) {
            rooms.set(roomCode, {
                clients: new Map(),
                locked: false,
                hostId: null,
                createdAt: new Date()
            });
            console.log(`[ODA] Yeni oda: #${roomCode}`);
        }

        const room = rooms.get(roomCode);

        if (room.locked && room.clients.size > 0) {
            ws.send(JSON.stringify({ type: 'locked' }));
            return;
        }

        if (room.clients.size >= MAX_ROOM_SIZE) {
            ws.send(JSON.stringify({ type: 'full', max: MAX_ROOM_SIZE }));
            return;
        }

        const isHost = room.clients.size === 0;
        if (isHost) room.hostId = clientId;

        room.clients.set(clientId, { ws, name: clientName, isHost });

        const peers = [];
        room.clients.forEach((client, id) => {
            if (id !== clientId) {
                peers.push({ id, name: client.name, isHost: id === room.hostId });
            }
        });

        ws.send(JSON.stringify({
            type: 'joined',
            id: clientId,
            hostId: room.hostId,
            isHost,
            locked: room.locked,
            peers
        }));

        broadcastToRoom(roomCode, {
            type: 'peer-joined',
            id: clientId,
            name: clientName,
            isHost: clientId === room.hostId
        }, clientId);

        console.log(`[+] ${clientName} → #${roomCode} [${room.clients.size}/${MAX_ROOM_SIZE}]`);
        logRoomStats();
    }

    function handleSignal(msg) {
        const { room: roomCode, to, data } = msg;
        if (!roomCode || !to || !data) return;
        sendToClient(roomCode, to, { type: 'signal', from: clientId, data });
    }

    function handleChat(msg) {
        const { room: roomCode, text } = msg;
        if (!roomCode || !text) return;
        const room = rooms.get(roomCode);
        if (!room) return;
        const client = room.clients.get(clientId);
        if (!client) return;
        const cleanText = text.trim().substring(0, 1000);
        if (!cleanText) return;
        broadcastToRoom(roomCode, {
            type: 'chat',
            senderId: clientId,
            from: client.name,
            text: cleanText
        });
    }

    function handleStatus(msg) {
        const { room: roomCode, action, value } = msg;
        if (!roomCode || !action) return;
        broadcastToRoom(roomCode, { type: 'status', id: clientId, action, value });
    }

    function handleReaction(msg) {
        const { room: roomCode, emoji } = msg;
        if (!roomCode || !emoji) return;
        const allowedEmojis = ['👍', '❤️', '👏', '😂', '😮', '🎉', '🔥', '👀'];
        if (!allowedEmojis.includes(emoji)) return;
        broadcastToRoom(roomCode, { type: 'reaction', id: clientId, emoji });
    }

    function handleControl(msg) {
        const { room: roomCode, action, value, targetId } = msg;
        if (!roomCode || !action) return;
        const room = rooms.get(roomCode);
        if (!room || clientId !== room.hostId) return;

        switch (action) {
            case 'lock-room':
                room.locked = !!value;
                broadcastToRoom(roomCode, { type: 'room-lock', locked: room.locked });
                break;
            case 'mute-mic':
                if (targetId && targetId !== clientId) {
                    sendToClient(roomCode, targetId, { type: 'control', action: 'mute-mic' });
                }
                break;
        }
    }

    ws.on('close', () => {
        if (!currentRoom || !clientId) return;
        const room = rooms.get(currentRoom);
        if (!room) return;

        const wasHost = clientId === room.hostId;
        room.clients.delete(clientId);
        broadcastToRoom(currentRoom, { type: 'peer-left', id: clientId, name: clientName });
        console.log(`[-] ${clientName} ← #${currentRoom}`);

        if (room.clients.size === 0) {
            rooms.delete(currentRoom);
        } else if (wasHost) {
            room.hostId = room.clients.keys().next().value;
            const newHost = room.clients.get(room.hostId);
            if (newHost) newHost.isHost = true;
            broadcastToRoom(currentRoom, { type: 'host-changed', hostId: room.hostId });
        }
        logRoomStats();
    });

    ws.on('error', (error) => {
        console.error(`[HATA] WebSocket:`, error.message);
    });

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ═══════════════════════════════════════════════════════════════
// BAŞLAT
// ═══════════════════════════════════════════════════════════════

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                     VibeZone Sunucusu                         ║
╠═══════════════════════════════════════════════════════════════╣
║   🚀 http://localhost:${PORT}                                    ║
║                                                               ║
║   Mevcut dosyalar kontrol ediliyor...                         ║
╚═══════════════════════════════════════════════════════════════╝
    `);
    
    // Başlangıçta mevcut dosyaları listele
    fs.readdir('.', (err, files) => {
        if (err) {
            console.error('[HATA] Dosyalar okunamadı:', err.message);
        } else {
            console.log('\n[DOSYALAR] Mevcut dosyalar:');
            files.forEach(file => {
                const isHtml = file.endsWith('.html');
                const isJs = file.endsWith('.js');
                const icon = isHtml ? '📄' : (isJs ? '⚙️' : '📁');
                console.log(`  ${icon} ${file}`);
            });
            
            // Gerekli dosyaları kontrol et
            const required = ['index.html', 'room.html'];
            const missing = required.filter(f => !files.includes(f));
            
            if (missing.length > 0) {
                console.log('\n⚠️  EKSİK DOSYALAR:');
                missing.forEach(f => console.log(`  ❌ ${f}`));
                console.log('\nBu dosyaları oluşturmanız gerekiyor!');
            } else {
                console.log('\n✅ Tüm gerekli dosyalar mevcut!');
            }
        }
    });
});

process.on('SIGINT', () => {
    console.log('\n[KAPATILIYOR]...');
    wss.clients.forEach((ws) => ws.close());
    server.close(() => process.exit(0));
});