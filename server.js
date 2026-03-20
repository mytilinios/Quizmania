const express = require("express");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const server = app.listen(PORT, () => console.log(`QuizMania running on port ${PORT}`));
const wss = new WebSocketServer({ server });

// rooms: { roomCode: { players: Map<id, {ws, name, score, colorIdx, isHost}>, category, started } }
const rooms = new Map();

function getRoomClients(roomCode) {
  return rooms.get(roomCode) || null;
}

function broadcastToRoom(roomCode, message, excludeId = null) {
  const room = getRoomClients(roomCode);
  if (!room) return;
  const data = JSON.stringify(message);
  room.players.forEach((player, id) => {
    if (id !== excludeId && player.ws.readyState === 1) {
      player.ws.send(data);
    }
  });
}

function sendToAll(roomCode, message) {
  broadcastToRoom(roomCode, message);
}

function getPlayersArray(roomCode) {
  const room = getRoomClients(roomCode);
  if (!room) return [];
  return Array.from(room.players.entries()).map(([id, p]) => ({
    id, name: p.name, score: p.score, colorIdx: p.colorIdx, isHost: p.isHost
  }));
}

wss.on("connection", (ws) => {
  let myId = null;
  let myRoom = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── CREATE ROOM ──
    if (msg.type === "CREATE_ROOM") {
      const code = Math.random().toString(36).substring(2, 7).toUpperCase();
      myId = msg.playerId;
      myRoom = code;
      rooms.set(code, {
        players: new Map([[myId, { ws, name: msg.name, score: 0, colorIdx: 0, isHost: true }]]),
        category: "general",
        started: false
      });
      ws.send(JSON.stringify({ type: "ROOM_CREATED", room: code, playerId: myId }));
      ws.send(JSON.stringify({ type: "PLAYERS_UPDATE", players: getPlayersArray(code) }));
    }

    // ── JOIN ROOM ──
    if (msg.type === "JOIN_ROOM") {
      const room = getRoomClients(msg.room);
      if (!room) {
        ws.send(JSON.stringify({ type: "ERROR", message: "Το δωμάτιο δεν βρέθηκε!" }));
        return;
      }
      myId = msg.playerId;
      myRoom = msg.room;
      const colorIdx = room.players.size % 5;
      room.players.set(myId, { ws, name: msg.name, score: 0, colorIdx, isHost: false });
      ws.send(JSON.stringify({ type: "ROOM_JOINED", room: myRoom, playerId: myId }));
      const players = getPlayersArray(myRoom);
      sendToAll(myRoom, { type: "PLAYERS_UPDATE", players });
    }

    // ── CATEGORY CHANGE ──
    if (msg.type === "CATEGORY_CHANGE") {
      const room = getRoomClients(myRoom);
      if (room) {
        room.category = msg.category;
        sendToAll(myRoom, { type: "CATEGORY_CHANGED", category: msg.category });
      }
    }

    // ── GAME START ──
    if (msg.type === "GAME_START") {
      const room = getRoomClients(myRoom);
      if (room) {
        room.started = true;
        sendToAll(myRoom, { type: "GAME_START", category: msg.category });
      }
    }

    // ── QUESTIONS READY (host sends after AI generates) ──
    if (msg.type === "QUESTIONS_READY") {
      sendToAll(myRoom, { type: "QUESTIONS_READY", questions: msg.questions, category: msg.category });
    }

    // ── ANSWER ──
    if (msg.type === "ANSWER") {
      broadcastToRoom(myRoom, {
        type: "ANSWER",
        playerId: msg.playerId,
        answer: msg.answer,
        timestamp: msg.timestamp
      }, myId);
    }

    // ── SHOW REVEAL ──
    if (msg.type === "SHOW_REVEAL") {
      sendToAll(myRoom, { type: "SHOW_REVEAL", roundPoints: msg.roundPoints });
    }

    // ── NEXT QUESTION ──
    if (msg.type === "NEXT_QUESTION") {
      // Update scores in room state
      const room = getRoomClients(myRoom);
      if (room && msg.players) {
        msg.players.forEach(p => {
          const player = room.players.get(p.id);
          if (player) player.score = p.score;
        });
      }
      sendToAll(myRoom, {
        type: "NEXT_QUESTION",
        players: msg.players,
        qIndex: msg.qIndex,
        total: msg.total,
        category: msg.category
      });
    }
  });

  ws.on("close", () => {
    if (!myRoom || !myId) return;
    const room = getRoomClients(myRoom);
    if (!room) return;
    room.players.delete(myId);
    if (room.players.size === 0) {
      rooms.delete(myRoom);
    } else {
      const players = getPlayersArray(myRoom);
      sendToAll(myRoom, { type: "PLAYERS_UPDATE", players });
    }
  });

  ws.on("error", () => {});
});

console.log("QuizMania server started!");
