const express = require("express");
const { WebSocketServer } = require("ws");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Find the correct public folder and index file regardless of case
function findFile(dir, names) {
  const files = fs.readdirSync(dir);
  for (const name of names) {
    const found = files.find(f => f.toLowerCase() === name.toLowerCase());
    if (found) return path.join(dir, found);
  }
  return null;
}

const rootFiles = fs.readdirSync(__dirname);
const publicFolder = rootFiles.find(f => f.toLowerCase() === "public");
const publicDir = publicFolder ? path.join(__dirname, publicFolder) : __dirname;
const indexFile = findFile(publicDir, ["index.html"]) || path.join(publicDir, "index.html");

console.log("Public dir:", publicDir);
console.log("Index file:", indexFile);

app.use(express.static(publicDir));
app.get("*", (_, res) => res.sendFile(indexFile));

const server = app.listen(PORT, () => console.log(`QuizMania running on port ${PORT}`));
const wss = new WebSocketServer({ server });

const rooms = new Map();

function broadcastToRoom(roomCode, message, excludeId = null) {
  const room = rooms.get(roomCode);
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
  const room = rooms.get(roomCode);
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

    if (msg.type === "CREATE_ROOM") {
      const code = Math.random().toString(36).substring(2, 7).toUpperCase();
      myId = msg.playerId;
      myRoom = code;
      rooms.set(code, {
        players: new Map([[myId, { ws, name: msg.name, score: 0, colorIdx: 0, isHost: true }]]),
        category: "general", started: false
      });
      ws.send(JSON.stringify({ type: "ROOM_CREATED", room: code, playerId: myId }));
      ws.send(JSON.stringify({ type: "PLAYERS_UPDATE", players: getPlayersArray(code) }));
    }

    if (msg.type === "JOIN_ROOM") {
      const room = rooms.get(msg.room);
      if (!room) { ws.send(JSON.stringify({ type: "ERROR", message: "Το δωμάτιο δεν βρέθηκε!" })); return; }
      myId = msg.playerId;
      myRoom = msg.room;
      room.players.set(myId, { ws, name: msg.name, score: 0, colorIdx: room.players.size % 5, isHost: false });
      ws.send(JSON.stringify({ type: "ROOM_JOINED", room: myRoom, playerId: myId }));
      sendToAll(myRoom, { type: "PLAYERS_UPDATE", players: getPlayersArray(myRoom) });
    }

    if (msg.type === "CATEGORY_CHANGE") {
      const room = rooms.get(myRoom);
      if (room) { room.category = msg.category; sendToAll(myRoom, { type: "CATEGORY_CHANGED", category: msg.category }); }
    }

    if (msg.type === "GAME_START") {
      const room = rooms.get(myRoom);
      if (room) { room.started = true; sendToAll(myRoom, { type: "GAME_START", category: msg.category }); }
    }

    if (msg.type === "QUESTIONS_READY") {
      sendToAll(myRoom, { type: "QUESTIONS_READY", questions: msg.questions, category: msg.category });
    }

    if (msg.type === "ANSWER") {
      broadcastToRoom(myRoom, { type: "ANSWER", playerId: msg.playerId, answer: msg.answer, timestamp: msg.timestamp }, myId);
    }

    if (msg.type === "SHOW_REVEAL") {
      sendToAll(myRoom, { type: "SHOW_REVEAL", roundPoints: msg.roundPoints });
    }

    if (msg.type === "NEXT_QUESTION") {
      const room = rooms.get(myRoom);
      if (room && msg.players) msg.players.forEach(p => { const pl = room.players.get(p.id); if (pl) pl.score = p.score; });
      sendToAll(myRoom, { type: "NEXT_QUESTION", players: msg.players, qIndex: msg.qIndex, total: msg.total, category: msg.category });
    }
  });

  ws.on("close", () => {
    if (!myRoom || !myId) return;
    const room = rooms.get(myRoom);
    if (!room) return;
    room.players.delete(myId);
    if (room.players.size === 0) rooms.delete(myRoom);
    else sendToAll(myRoom, { type: "PLAYERS_UPDATE", players: getPlayersArray(myRoom) });
  });

  ws.on("error", () => {});
});

console.log("QuizMania server started!");
