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
const zlib = require("zlib");
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

// ------------------------------------------------------------ Preparar os arquivos do jogo
// Se public/index.html não existir, procura um .zip com a exportação Web em qualquer pasta do
// repositório e extrai para public/. Assim funciona pelo celular (o GitHub não aceita o index.wasm
// de ~40 MB pelo navegador, mas aceita o .zip de ~10 MB), com ou sem Docker.

const diag = { zips: [], extracted: [], errors: [], files: [] };

function findZips(dir, depth) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out = out.concat(findZips(full, depth - 1));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".zip")) out.push(full);
  }
  return out;
}

// Leitor de .zip mínimo (arquivos "stored" e "deflate", que é o que os celulares e PCs geram).
function unzipFlat(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("não parece ser um .zip válido");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("índice do .zip corrompido");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;                       // pasta
    const base = path.basename(name.replace(/\\/g, "/"));
    if (!base || base.startsWith(".") || name.startsWith("__MACOSX")) continue;
    entries.push({ name, base, method, compSize, local });
  }
  // Só extrai um .zip que seja mesmo a versão Web do jogo (tem uma página .html).
  if (!entries.some((e) => e.base.toLowerCase().endsWith(".html"))) {
    throw new Error("não contém a versão Web (nenhum arquivo .html); ignorado");
  }
  const written = [];
  for (const { name, base, method, compSize, local } of entries) {
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`"${name}" usa um tipo de compressão não suportado (${method}); compacte como ZIP comum`);
    fs.writeFileSync(path.join(destDir, base), data);        // "achata" pastas: só o nome do arquivo
    written.push(`${base} (${(data.length / 1048576).toFixed(1)} MB)`);
  }
  return written;
}

function prepareGame() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  if (!fs.existsSync(path.join(PUBLIC_DIR, "index.html"))) {
    // Só dentro do repositório (nunca em pastas acima, que no servidor têm arquivos do sistema).
    const roots = [...new Set([__dirname, process.cwd()])];
    let zips = [];
    for (const r of roots) zips = zips.concat(findZips(r, 3));
    diag.zips = [...new Set(zips)];
    for (const z of diag.zips) {
      try {
        const got = unzipFlat(z, PUBLIC_DIR);
        diag.extracted.push(`${path.relative(__dirname, z) || z}: ${got.join(", ")}`);
        if (!fs.existsSync(path.join(PUBLIC_DIR, "index.html"))) {
          // Exportação com outro nome (ex.: jogo.html): serve essa página como a inicial.
          const html = fs.readdirSync(PUBLIC_DIR).find((f) => f.toLowerCase().endsWith(".html"));
          if (html) fs.copyFileSync(path.join(PUBLIC_DIR, html), path.join(PUBLIC_DIR, "index.html"));
        }
        if (fs.existsSync(path.join(PUBLIC_DIR, "index.html"))) break;
      } catch (e) {
        diag.errors.push(`${path.basename(z)}: ${e.message}`);
      }
    }
  }
  try { diag.files = fs.readdirSync(PUBLIC_DIR); } catch {}
  console.log("Arquivos do jogo em public/:", diag.files.join(", ") || "(nenhum)");
  if (diag.zips.length) console.log(".zip encontrados:", diag.zips.join(", "));
  for (const e of diag.errors) console.log("ERRO ao extrair:", e);
}
prepareGame();

// Página explicando o que falta, em vez de uma mensagem genérica.
function missingPage() {
  let top = [];
  try { top = fs.readdirSync(__dirname).filter((f) => f !== "node_modules"); } catch {}
  const li = (arr) => (arr.length ? arr.map((x) => `<li>${String(x).replace(/</g, "&lt;")}</li>`).join("") : "<li>(nenhum)</li>");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;background:#111;color:#eee;padding:16px;line-height:1.45}h2{color:#fd5}code{color:#8f8}</style>
<h2>O jogo ainda não está no servidor</h2>
<p>Falta o arquivo <code>index.html</code> da versão Web. Envie para o repositório do GitHub um <b>.zip</b>
com os arquivos <code>index.*</code> da exportação Web (index.html, index.js, index.wasm, index.pck...).
O servidor extrai o .zip sozinho ao iniciar.</p>
<p><b>Arquivos na pasta do servidor:</b></p><ul>${li(top)}</ul>
<p><b>.zip encontrados:</b></p><ul>${li(diag.zips.map((z) => path.relative(__dirname, z) || z))}</ul>
<p><b>Extraído:</b></p><ul>${li(diag.extracted)}</ul>
<p><b>Erros:</b></p><ul>${li(diag.errors)}</ul>
<p><b>Arquivos do jogo (public/):</b></p><ul>${li(diag.files)}</ul>`;
}

// ------------------------------------------------------------ Downloads das versões instaláveis
// /download/<plataforma>: serve public/downloads/<arquivo> se existir; senão redireciona para a
// última Release do GitHub (variável DOWNLOADS_REPO = "usuario/repositorio"). iOS só existe pela
// App Store / TestFlight (variável IOS_URL). /downloads.json diz o que está disponível.
const DOWNLOAD_FILES = {
  android: "futebol-fps-android.apk",
  windows: "futebol-fps-windows.zip",
  macos: "futebol-fps-macos.zip",
  linux: "futebol-fps-linux.zip",
};
const DOWNLOADS_REPO = (process.env.DOWNLOADS_REPO || "").trim();
const IOS_URL = (process.env.IOS_URL || "").trim();

function downloadAvailable(platform) {
  if (platform === "ios") return IOS_URL !== "";
  const f = DOWNLOAD_FILES[platform];
  if (!f) return false;
  return DOWNLOADS_REPO !== "" || fs.existsSync(path.join(PUBLIC_DIR, "downloads", f));
}

function infoPage(res, en, title, body) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;background:#1d4fb8;color:#fbf5e4;padding:24px;line-height:1.5;max-width:640px;margin:auto}
h2{color:#f6e3a6}a{color:#f6e3a6}</style><h2>${title}</h2>${body}
<p><a href="/">${en ? "Back to the game" : "Voltar ao jogo"}</a></p>`);
}

function handleDownload(req, res, url) {
  const en = !String(req.headers["accept-language"] || "").toLowerCase().startsWith("pt");
  if (url === "/downloads.json") {
    const out = {};
    for (const p of ["android", "ios", "windows", "macos", "linux"]) out[p] = downloadAvailable(p);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    return res.end(JSON.stringify(out));
  }
  const platform = url.slice("/download/".length).toLowerCase();
  if (platform === "ios") {
    if (IOS_URL) { res.writeHead(302, { Location: IOS_URL }); return res.end(); }
    return infoPage(res, en, en ? "iPhone / iPad" : "iPhone / iPad", en
      ? "<p>Apple only allows installing apps on iPhone and iPad through the App Store or TestFlight, so there is no file to download here.</p><p>You can play right now in <b>Safari</b>: open this site on your iPhone and tap Play.</p>"
      : "<p>A Apple só permite instalar apps no iPhone e no iPad pela App Store ou pelo TestFlight, então não há arquivo para baixar aqui.</p><p>Você pode jogar agora mesmo pelo <b>Safari</b>: abra este site no iPhone e toque em Jogar.</p>");
  }
  const file = DOWNLOAD_FILES[platform];
  if (!file) { res.writeHead(404); return res.end(); }
  const local = path.join(PUBLIC_DIR, "downloads", file);
  if (fs.existsSync(local)) {
    res.writeHead(200, {
      "Content-Type": platform === "android" ? "application/vnd.android.package-archive" : "application/zip",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Content-Length": fs.statSync(local).size,
    });
    return fs.createReadStream(local).pipe(res);
  }
  if (DOWNLOADS_REPO) {
    res.writeHead(302, { Location: `https://github.com/${DOWNLOADS_REPO}/releases/latest/download/${file}` });
    return res.end();
  }
  return infoPage(res, en, en ? "Not available yet" : "Ainda não disponível", en
    ? "<p>This version hasn't been published yet. Meanwhile, you can play in the browser.</p>"
    : "<p>Esta versão ainda não foi publicada. Enquanto isso, dá para jogar no navegador.</p>");
}


// ------------------------------------------------------------ HTTP (arquivos do jogo)

const server = http.createServer((req, res) => {
  let url;
  try {
    url = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (url === "/downloads.json" || url.startsWith("/download/")) return handleDownload(req, res, url);
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
      if (url === "/index.html") {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(missingPage());
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Arquivo não encontrado: " + url);
    }
    // (Sem cabeçalhos de isolamento COOP/COEP: a exportação é sem threads e não precisa deles;
    // no Safari do iPhone eles já causaram falha ao carregar o áudio.)
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    if (url === "/index.html") data = Buffer.from(String(data).replace("</head>", DIAG_SCRIPT + "</head>"));
    res.end(data);
  });
});

// Diagnóstico na página do jogo: se algo falhar (por exemplo num iPhone), a mensagem aparece
// na tela em vez de uma tela preta — dá para tirar um print e corrigir.
const DIAG_SCRIPT = `<script>
(function () {
  var box = null, lines = [];
  function show(msg) {
    lines.push(msg);
    var put = function () {
      if (!box) {
        box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:3000;max-height:45%;overflow:auto;' +
          'background:rgba(110,0,0,.92);color:#fff;font:13px/1.35 monospace;padding:10px;white-space:pre-wrap';
        box.onclick = function () { box.remove(); box = null; lines = []; };
        document.body.appendChild(box);
      }
      box.textContent = 'Problema ao abrir o jogo (toque para fechar):\n' + lines.join('\n') +
        '\n\n' + navigator.userAgent;
    };
    if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
  }
  window.addEventListener('error', function (e) {
    show('Erro: ' + (e.message || e) + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason; show('Erro: ' + (r && (r.message || r.toString())) );
  });
  try {
    if (!document.createElement('canvas').getContext('webgl2'))
      show('Este navegador não tem WebGL 2, que o jogo precisa. No iPhone, atualize para o iOS 15 ou mais novo.');
  } catch (e) {}
  if (typeof WebAssembly !== 'object') show('Este navegador não tem WebAssembly, que o jogo precisa.');
})();
</script>`;

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
  const target = data.readUInt16LE(0);
  if (target === 0xffff) {
    // Para todos da sala (voz): quem estiver com a conexão lenta perde o pacote, sem acumular.
    for (const p of room.peers.values()) {
      if (p !== ws && p.readyState === 1 && p.bufferedAmount < 256 * 1024) p.send(out, { binary: true });
    }
    return;
  }
  if (room.host === ws) {
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
      case "kick": {
        // Só o anfitrião: tira da sala um jogador que ficou inativo (o bot assume a vaga).
        const room = ws.room;
        if (!room || room.host !== ws) break;
        const peer = room.peers.get(Number(msg.id));
        if (!peer || peer === ws) break;
        send(peer, { type: "room_closed", message: "Você ficou inativo e saiu da partida." });
        leaveRoom(peer);
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
}, 10000);   // conexão morta (sem responder ao ping) cai em até ~20 s

server.listen(PORT, () => {
  console.log(`Futebol FPS: http://localhost:${PORT}  (WebSocket em /ws)`);
});
