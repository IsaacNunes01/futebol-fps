// Servidor do Futebol FPS
// - Serve a versão Web exportada (pasta ./public)
// - Gerencia salas por WebSocket em /ws (criar, listar públicas, entrar por código,
//   alternar pública/privada a qualquer momento)
// - Repassa as mensagens binárias do jogo entre o anfitrião e os jogadores
//
// Protocolo binário (2 bytes little-endian no início de cada pacote):
//   anfitrião -> servidor: [destino][dados]  (destino 0 = todos os jogadores)
//   jogador   -> servidor: [ignorado][dados] (sempre vai para o anfitrião)
//   servidor  -> qualquer: [id de quem enviou][dados]

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");
// 20 = todos os jogadores de linha dos dois times (os goleiros são sempre bots).
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || "20", 10);
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

// ------------------------------------------------------------ HTTP (arquivos do jogo)

const server = http.createServer((req, res) => {
  let url;
  try {
    url = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  if (url === "/") url = "/index.html";
  const file = path.join(PUBLIC_DIR, path.normalize(url));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Arquivo não encontrado. Exporte a versão Web do jogo para server/public/index.html");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      // Permitem também exportações Web com threads.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

// ------------------------------------------------------------ Salas

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 * 1024 });
const rooms = new Map(); // código -> sala
let nextId = 1;

function genCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}

function cleanName(name, fallback = "Jogador") {
  const s = String(name || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16);
  return s || fallback;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function roomInfo(room) {
  return { code: room.code, name: room.name, public: room.public, players: room.peers.size, max: room.max };
}

function broadcastRoomUpdate(room) {
  const msg = {
    type: "room_update",
    ...roomInfo(room),
    host_id: room.host.id,
    peers: [...room.peers.values()].map((p) => ({ id: p.id, name: p.name })),
  };
  for (const p of room.peers.values()) send(p, msg);
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.peers.delete(ws.id);
  if (room.host === ws) {
    for (const p of room.peers.values()) {
      p.room = null;
      send(p, { type: "room_closed", message: "O anfitrião encerrou a partida." });
    }
    rooms.delete(room.code);
    console.log(`Sala ${room.code} encerrada`);
  } else {
    send(room.host, { type: "peer_left", id: ws.id });
    broadcastRoomUpdate(room);
  }
}

function relay(ws, data) {
  const room = ws.room;
  if (!room || data.length < 2) return;
  const out = Buffer.from(data); // cópia, para trocar o cabeçalho
  out.writeUInt16LE(ws.id, 0);
  if (room.host === ws) {
    const target = data.readUInt16LE(0);
    if (target === 0) {
      for (const p of room.peers.values()) {
        // Não acumula estado para quem está com a conexão lenta.
        if (p !== ws && p.readyState === 1 && p.bufferedAmount < 512 * 1024) p.send(out, { binary: true });
      }
    } else {
      const p = room.peers.get(target);
      if (p && p.readyState === 1) p.send(out, { binary: true });
    }
  } else if (room.host.readyState === 1) {
    room.host.send(out, { binary: true });
  }
}

wss.on("connection", (ws) => {
  ws.id = nextId;
  nextId = nextId >= 65000 ? 1 : nextId + 1;
  ws.name = "Jogador";
  ws.room = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  send(ws, { type: "welcome", id: ws.id });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return relay(ws, data);
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "list": {
        const list = [...rooms.values()].filter((r) => r.public).map(roomInfo);
        send(ws, { type: "rooms", rooms: list });
        break;
      }
      case "create": {
        leaveRoom(ws);
        ws.name = cleanName(msg.name);
        const room = {
          code: genCode(),
          name: cleanName(msg.room_name, `Partida de ${ws.name}`).slice(0, 32),
          public: !!msg.public,
          host: ws,
          peers: new Map([[ws.id, ws]]),
          max: MAX_PLAYERS,
        };
        rooms.set(room.code, room);
        ws.room = room;
        send(ws, { type: "created", id: ws.id, ...roomInfo(room) });
        broadcastRoomUpdate(room);
        console.log(`Sala ${room.code} criada por ${ws.name} (${room.public ? "pública" : "privada"})`);
        break;
      }
      case "set_public": {
        // Só o anfitrião pode mudar, e a qualquer momento.
        if (ws.room && ws.room.host === ws) {
          ws.room.public = !!msg.public;
          broadcastRoomUpdate(ws.room);
        }
        break;
      }
      case "join": {
        const code = String(msg.code || "").toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) return send(ws, { type: "error", message: "Partida não encontrada. Confira o código." });
        if (room.peers.size >= room.max) return send(ws, { type: "error", message: "A partida está cheia." });
        leaveRoom(ws);
        ws.name = cleanName(msg.name);
        room.peers.set(ws.id, ws);
        ws.room = room;
        send(ws, { type: "joined", id: ws.id, host_id: room.host.id, ...roomInfo(room) });
        send(room.host, { type: "peer_joined", id: ws.id, name: ws.name });
        broadcastRoomUpdate(room);
        break;
      }
      case "leave":
        leaveRoom(ws);
        break;
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

// Derruba conexões mortas.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Futebol FPS: http://localhost:${PORT}  (WebSocket em /ws)`);
});
