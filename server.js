// VibeZone - Express + WebSocket (ws) sinyal sunucusu
// HTTP:  http://localhost:3000
// WS:    ws://localhost:3000

const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Statik dosyalar (index.html, room.html)
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`VibeZone sunucusu http://localhost:${PORT} üzerinde çalışıyor`);
});

// roomCode -> { peers: WebSocket[], hostId: string|null, locked: boolean }
const rooms = {};
const MAX_PER_ROOM = 8; // Oda kapasitesi

function broadcast(roomObj, payload) {
    const msg = JSON.stringify(payload);
    roomObj.peers.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

function findRoomOf(ws) {
    const roomCode = ws.room;
    if (!roomCode) return null;
    return rooms[roomCode] || null;
}

wss.on("connection", (ws) => {
    ws.id = Math.random().toString(36).substring(2, 10);

    ws.on("message", (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error("Geçersiz JSON:", e);
            return;
        }

        if (data.type === "join") {
            const room = data.room;
            const name = (data.name || "Misafir").toString().substring(0, 32);

            if (!room || !/^\d{6}$/.test(room)) {
                ws.send(JSON.stringify({ type: "error", message: "Geçersiz oda kodu" }));
                return;
            }

            let roomObj = rooms[room];

            // İlk kullanıcı odayı oluşturur ve host olur
            if (!roomObj) {
                roomObj = rooms[room] = {
                    peers: [],
                    hostId: ws.id,
                    locked: false
                };
            }

            if (roomObj.locked) {
                ws.send(JSON.stringify({ type: "locked" }));
                return;
            }

            if (roomObj.peers.length >= MAX_PER_ROOM) {
                ws.send(JSON.stringify({ type: "full", max: MAX_PER_ROOM }));
                return;
            }

            ws.room = room;
            ws.name = name;

            const existingPeers = roomObj.peers.map((p) => ({
                id: p.id,
                name: p.name,
                isHost: p.id === roomObj.hostId
            }));

            roomObj.peers.push(ws);

            ws.send(
                JSON.stringify({
                    type: "joined",
                    id: ws.id,
                    isHost: ws.id === roomObj.hostId,
                    hostId: roomObj.hostId,
                    locked: roomObj.locked,
                    peers: existingPeers
                })
            );

            // Diğer kullanıcılara yeni katılımcıyı bildir
            roomObj.peers.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(
                        JSON.stringify({
                            type: "peer-joined",
                            id: ws.id,
                            name: ws.name,
                            isHost: false
                        })
                    );
                }
            });
        } else if (data.type === "signal") {
            // WebRTC sinyalleri: belirli hedefe ilet
            const roomObj = findRoomOf(ws);
            if (!roomObj) return;

            const targetId = data.to;
            if (!targetId) return;

            const target = roomObj.peers.find((c) => c.id === targetId);
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(
                    JSON.stringify({
                        type: "signal",
                        from: ws.id,
                        data: data.data
                    })
                );
            }
        } else if (data.type === "chat") {
            // Oda içi sohbet
            const roomObj = findRoomOf(ws);
            if (!roomObj) return;
            const text = (data.text || "").toString().slice(0, 500);
            if (!text) return;

            const payload = JSON.stringify({
                type: "chat",
                from: ws.name,
                text,
                senderId: ws.id
            });

            roomObj.peers.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(payload);
                }
            });
        } else if (data.type === "control") {
            // Host kontrolleri (oda kilitle, uzak mute vb.)
            const roomObj = findRoomOf(ws);
            if (!roomObj) return;

            // Sadece host kontrol gönderebilir
            if (roomObj.hostId !== ws.id) return;

            const action = data.action;

            if (action === "lock-room") {
                roomObj.locked = !!data.value;
                broadcast(roomObj, {
                    type: "room-lock",
                    locked: roomObj.locked
                });
            } else if (action === "mute-mic") {
                const targetId = data.targetId;
                if (!targetId) return;
                const target = roomObj.peers.find((c) => c.id === targetId);
                if (target && target.readyState === WebSocket.OPEN) {
                    target.send(
                        JSON.stringify({
                            type: "control",
                            action: "mute-mic"
                        })
                    );
                }
            }
        } else if (data.type === "status") {
            // Örn: el kaldırma
            const roomObj = findRoomOf(ws);
            if (!roomObj) return;

            broadcast(roomObj, {
                type: "status",
                action: data.action,
                id: ws.id,
                value: data.value
            });
        } else if (data.type === "reaction") {
            // Emoji reaksiyonları
            const roomObj = findRoomOf(ws);
            if (!roomObj) return;
            const emoji = (data.emoji || "").toString().slice(0, 8);
            if (!emoji) return;

            broadcast(roomObj, {
                type: "reaction",
                id: ws.id,
                emoji
            });
        }
    });

    ws.on("close", () => {
        const room = ws.room;
        if (!room || !rooms[room]) return;

        const roomObj = rooms[room];
        roomObj.peers = roomObj.peers.filter((c) => c !== ws);

        if (roomObj.peers.length === 0) {
            delete rooms[room];
            return;
        }

        // Diğer kullanıcılara ayrılan kişiyi bildir
        broadcast(roomObj, {
            type: "peer-left",
            id: ws.id,
            name: ws.name
        });

        // Host ayrıldıysa yeni host ata
        if (roomObj.hostId === ws.id) {
            const newHost = roomObj.peers[0];
            roomObj.hostId = newHost.id;
            broadcast(roomObj, {
                type: "host-changed",
                hostId: roomObj.hostId
            });
        }
    });

    ws.on("error", (err) => {
        console.error("WebSocket hata:", err);
    });
});
