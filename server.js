const express = require("express");
const { WebSocketServer } = require("ws");
const path = require("path");
const fs = require("fs");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "2mb" }));

// Serve frontend
const rootFiles = fs.readdirSync(__dirname);
const publicFolder = rootFiles.find(f => f.toLowerCase() === "public");
const publicDir = publicFolder ? path.join(__dirname, publicFolder) : __dirname;
const indexFiles = fs.readdirSync(publicDir);
const indexFile = indexFiles.find(f => f.toLowerCase() === "index.html");
const indexPath = indexFile ? path.join(publicDir, indexFile) : path.join(__dirname, "index.html");

app.use(express.static(publicDir));

// ── AI Proxy ──────────────────────────────────────────────────────────
app.post("/api/generate", (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt" });

  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }]
  });

  const options = {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "anthropic-version": "2023-06-01"
    }
  };

  const apiReq = https.request(options, apiRes => {
    let data = "";
    apiRes.on("data", chunk => data += chunk);
    apiRes.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        console.log("AI response status:", apiRes.statusCode);
        if (parsed.error) {
          console.log("AI error:", parsed.error);
          return res.status(500).json({ error: parsed.error.message });
        }
        const text = parsed.content?.map(b => b.text || "").join("") || "{}";
        // Clean and parse JSON from AI response
        const clean = text.replace(/```json|```/g, "").trim();
        console.log("AI text (first 200):", clean.substring(0, 200));
        res.json({ text: clean });
      } catch (e) {
        console.log("Parse error:", e.message, "Raw:", data.substring(0, 300));
        res.status(500).json({ error: "Parse error: " + e.message });
      }
    });
  });

  apiReq.on("error", e => {
    console.log("Request error:", e.message);
    res.status(500).json({ error: e.message });
  });
  apiReq.write(body);
  apiReq.end();
});

// ── iTunes Proxy ──────────────────────────────────────────────────────
app.get("/api/preview", (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [] });
  const url = `/search?term=${encodeURIComponent(q)}&media=music&limit=1`;
  const opts = { hostname: "itunes.apple.com", path: url, method: "GET" };
  https.get(opts, apiRes => {
    let data = "";
    apiRes.on("data", chunk => data += chunk);
    apiRes.on("end", () => {
      try { res.json(JSON.parse(data)); }
      catch { res.json({ results: [] }); }
    });
  }).on("error", () => res.json({ results: [] }));
});

app.get("*", (_, res) => res.sendFile(indexPath));

const server = app.listen(PORT, () => console.log(`QuizMania running on port ${PORT}`));
const wss = new WebSocketServer({ server });
const rooms = new Map();

function broadcastToRoom(roomCode, message, excludeId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const data = JSON.stringify(message);
  room.players.forEach((player, id) => {
    if (id !== excludeId && player.ws.readyState === 1) player.ws.send(data);
  });
}
function sendToAll(roomCode, message) { broadcastToRoom(roomCode, message); }
function getPlayersArray(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  return Array.from(room.players.entries()).map(([id, p]) => ({
    id, name: p.name, score: p.score, colorIdx: p.colorIdx, isHost: p.isHost
  }));
}

wss.on("connection", (ws) => {
  let myId = null, myRoom = null;
  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "CREATE_ROOM") {
      const code = Math.random().toString(36).substring(2, 7).toUpperCase();
      myId = msg.playerId; myRoom = code;
      rooms.set(code, { players: new Map([[myId, { ws, name: msg.name, score: 0, colorIdx: 0, isHost: true }]]), category: "general", started: false });
      ws.send(JSON.stringify({ type: "ROOM_CREATED", room: code, playerId: myId }));
      ws.send(JSON.stringify({ type: "PLAYERS_UPDATE", players: getPlayersArray(code) }));
    }
    if (msg.type === "JOIN_ROOM") {
      const room = rooms.get(msg.room);
      if (!room) { ws.send(JSON.stringify({ type: "ERROR", message: "Το δωμάτιο δεν βρέθηκε!" })); return; }
      myId = msg.playerId; myRoom = msg.room;
      room.players.set(myId, { ws, name: msg.name, score: 0, colorIdx: room.players.size % 5, isHost: false });
      ws.send(JSON.stringify({ type: "ROOM_JOINED", room: myRoom, playerId: myId }));
      sendToAll(myRoom, { type: "PLAYERS_UPDATE", players: getPlayersArray(myRoom) });
    }
    if (msg.type === "CATEGORY_CHANGE") { const room = rooms.get(myRoom); if (room) { room.category = msg.category; sendToAll(myRoom, { type: "CATEGORY_CHANGED", category: msg.category }); } }
    if (msg.type === "GAME_START") { const room = rooms.get(myRoom); if (room) { room.started = true; sendToAll(myRoom, { type: "GAME_START", category: msg.category }); } }
    if (msg.type === "QUESTIONS_READY") { sendToAll(myRoom, { type: "QUESTIONS_READY", questions: msg.questions, category: msg.category }); }
    if (msg.type === "ANSWER") { broadcastToRoom(myRoom, { type: "ANSWER", playerId: msg.playerId, answer: msg.answer, timestamp: msg.timestamp }, myId); }
    if (msg.type === "SHOW_REVEAL") { sendToAll(myRoom, { type: "SHOW_REVEAL", roundPoints: msg.roundPoints }); }
    if (msg.type === "NEXT_QUESTION") {
      const room = rooms.get(myRoom);
      if (room && msg.players) msg.players.forEach(p => { const pl = room.players.get(p.id); if (pl) pl.score = p.score; });
      sendToAll(myRoom, { type: "NEXT_QUESTION", players: msg.players, qIndex: msg.qIndex, total: msg.total, category: msg.category });
    }
  });
  ws.on("close", () => {
    if (!myRoom || !myId) return;
    const room = rooms.get(myRoom); if (!room) return;
    room.players.delete(myId);
    if (room.players.size === 0) rooms.delete(myRoom);
    else sendToAll(myRoom, { type: "PLAYERS_UPDATE", players: getPlayersArray(myRoom) });
  });
  ws.on("error", () => {});
});
console.log("QuizMania server started!");
