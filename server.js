// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Production'da spesifik domainlerle sınırlandırın
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Memory-based room management
const rooms = new Map(); // roomId -> { peers: Map, mode: string }
const peers = new Map(); // socket.id -> { roomId, peerId, mode }

// Generate unique peer ID
function generatePeerId() {
    return crypto.randomBytes(4).toString('hex');
}

// Get room info
function getRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            peers: new Map(),
            mode: 'chat', // default mode
            createdAt: Date.now()
        });
    }
    return rooms.get(roomId);
}

// Broadcast to all peers in room except sender
function broadcastToRoom(roomId, senderId, event, data) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.peers.forEach((peer, peerId) => {
        if (peerId !== senderId) {
            peer.socket.emit(event, { ...data, from: senderId });
        }
    });
}

// Express routes
app.use(express.static('public')); // Serve static files (HTML, CSS, JS)

app.get('/api/rooms/:roomId', (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    
    res.json({
        roomId: req.params.roomId,
        peerCount: room.peers.size,
        mode: room.mode,
        createdAt: room.createdAt
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        rooms: rooms.size, 
        peers: peers.size,
        uptime: process.uptime()
    });
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`[CONNECT] Peer connected: ${socket.id}`);
    
    const peerId = generatePeerId();
    let currentRoom = null;

    // Join a room
    socket.on('join-room', (data) => {
        const { roomId, mode = 'chat' } = data;
        
        // Leave previous room if any
        if (currentRoom) {
            socket.leave(currentRoom);
            const oldRoom = rooms.get(currentRoom);
            if (oldRoom) {
                oldRoom.peers.delete(peerId);
                if (oldRoom.peers.size === 0) {
                    rooms.delete(currentRoom);
                    console.log(`[ROOM] Room deleted: ${currentRoom}`);
                }
            }
        }

        // Join new room
        socket.join(roomId);
        currentRoom = roomId;
        
        const room = getRoom(roomId);
        room.peers.set(peerId, {
            socket: socket,
            peerId: peerId,
            mode: mode,
            joinedAt: Date.now()
        });
        
        peers.set(socket.id, {
            roomId: roomId,
            peerId: peerId,
            mode: mode
        });

        // Notify other peers
        socket.to(roomId).emit('peer-joined', {
            peerId: peerId,
            mode: mode,
            timestamp: Date.now()
        });

        // Send current room state to new peer
        const peerList = Array.from(room.peers.keys()).filter(id => id !== peerId);
        socket.emit('room-state', {
            roomId: roomId,
            mode: room.mode,
            peers: peerList,
            you: peerId
        });

        console.log(`[JOIN] Peer ${peerId} joined room ${roomId} (${mode})`);
    });

    // WebRTC signaling
    socket.on('offer', (data) => {
        const { to, offer } = data;
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        const targetPeer = room.peers.get(to);
        if (targetPeer) {
            targetPeer.socket.emit('offer', {
                from: peerId,
                offer: offer,
                mode: peers.get(socket.id)?.mode || 'chat'
            });
            console.log(`[SIGNAL] Offer from ${peerId} to ${to}`);
        }
    });

    socket.on('answer', (data) => {
        const { to, answer } = data;
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        const targetPeer = room.peers.get(to);
        if (targetPeer) {
            targetPeer.socket.emit('answer', {
                from: peerId,
                answer: answer
            });
            console.log(`[SIGNAL] Answer from ${peerId} to ${to}`);
        }
    });

    socket.on('ice-candidate', (data) => {
        const { to, candidate } = data;
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        const targetPeer = room.peers.get(to);
        if (targetPeer) {
            targetPeer.socket.emit('ice-candidate', {
                from: peerId,
                candidate: candidate
            });
            console.log(`[SIGNAL] ICE candidate from ${peerId} to ${to}`);
        }
    });

    // Mode switching
    socket.on('mode-change', (data) => {
        const { mode } = data;
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        const peer = room?.peers.get(peerId);
        if (!room || !peer) return;
        
        peer.mode = mode;
        peers.get(socket.id).mode = mode;
        room.mode = mode; // Room takes the latest mode
        
        // Broadcast mode change
        broadcastToRoom(currentRoom, peerId, 'mode-changed', {
            peerId: peerId,
            mode: mode
        });
        
        console.log(`[MODE] Peer ${peerId} changed to ${mode} mode`);
    });

    // Chat messaging (can be P2P, but server relays for reliability)
    socket.on('chat-message', (data) => {
        const { message } = data;
        if (!currentRoom) return;
        
        const messageData = {
            peerId: peerId,
            message: message,
            timestamp: Date.now()
        };
        
        // Store last 100 messages per room (optional)
        const room = rooms.get(currentRoom);
        if (room) {
            if (!room.messages) room.messages = [];
            room.messages.push(messageData);
            if (room.messages.length > 100) room.messages.shift();
        }
        
        broadcastToRoom(currentRoom, peerId, 'chat-message', messageData);
        console.log(`[CHAT] Message from ${peerId}: ${message.substring(0, 50)}...`);
    });

    // File transfer signaling
    socket.on('file-meta', (data) => {
        const { to, metadata } = data;
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        const targetPeer = room.peers.get(to);
        if (targetPeer) {
            targetPeer.socket.emit('file-meta', {
                from: peerId,
                metadata: metadata
            });
            console.log(`[FILE] Meta from ${peerId} to ${to}: ${metadata.name}`);
        }
    });

    socket.on('file-chunk', (data) => {
        const { to, chunk } = data;
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        const targetPeer = room.peers.get(to);
        if (targetPeer) {
            targetPeer.socket.emit('file-chunk', {
                from: peerId,
                chunk: chunk
            });
            // Note: In production, use direct P2P DataChannel for chunks
            // This is just for signaling readiness
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] Peer disconnected: ${socket.id}`);
        
        const peerData = peers.get(socket.id);
        if (peerData) {
            const { roomId } = peerData;
            const room = rooms.get(roomId);
            
            if (room) {
                room.peers.delete(peerData.peerId);
                broadcastToRoom(roomId, peerData.peerId, 'peer-left', {
                    peerId: peerData.peerId,
                    timestamp: Date.now()
                });
                
                if (room.peers.size === 0) {
                    rooms.delete(roomId);
                    console.log(`[ROOM] Room deleted: ${roomId}`);
                }
            }
            
            peers.delete(socket.id);
        }
    });

    // Error handling
    socket.on('error', (error) => {
        console.error(`[ERROR] Socket error for ${socket.id}:`, error);
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Stopping server...');
    server.close(() => {
        console.log('[SHUTDOWN] Server stopped');
        process.exit(0);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   Webber.io P2P Signal Server          ║
║   Running on http://localhost:${PORT}      ║
║   Mode: Multi-modal P2P Signaling      ║
║   Protocol: WebRTC + Socket.io         ║
╚════════════════════════════════════════╝
    `);
});

// Export for testing
module.exports = { app, server, io, rooms, peers };