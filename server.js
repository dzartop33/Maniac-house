/**
 * ДОМ ПАЛАЧА — мультиплеерный сервер
 *
 * Запуск:   npm install && npm start
 * Откроется HTTP-сервер на http://<твой-IP>:8080
 * Все игроки в той же Wi-Fi сети увидят твою комнату автоматически (mDNS)
 *
 * Структура:
 *  - HTTP сервер раздаёт index.html и client-multiplayer.js
 *  - WebSocket сервер для realtime синхронизации
 *  - mDNS-анонс _maniachouse._tcp.local для автообнаружения
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Bonjour } = require('bonjour-service');

const PORT = parseInt(process.env.PORT || '8080', 10);

// ============================================================
// HTTP сервер — раздаёт статические файлы
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';

  // Эндпоинт списка комнат для клиентов (если mDNS заблокирован)
  if (url === '/rooms') {
    res.writeHead(200, {'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(getRoomList()));
    return;
  }
  if (url === '/info') {
    res.writeHead(200, {'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({
      name: serverConfig.roomName,
      host: serverConfig.hostName,
      mode: serverConfig.mode,
      players: clients.size,
      maxPlayers: 4,
      port: PORT,
    }));
    return;
  }

  const filePath = path.join(__dirname, url);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
    res.end(data);
  });
});

// ============================================================
// WebSocket сервер — реалтайм синхронизация
// ============================================================
const wss = new WebSocketServer({ server });

// Структура клиента: { id, ws, name, role, x, y, dir, hidden, inv, alive }
const clients = new Map();
let nextId = 1;

const serverConfig = {
  roomName: process.env.ROOM_NAME || `Комната ${os.hostname()}`,
  hostName: os.hostname(),
  mode: 'coop',     // 'coop' (все жертвы, бот-маньяк) | 'pvp' (один маньяк-игрок)
  maxPlayers: 4,
  // Игровое состояние (синхронизируется хостом)
  worldSeed: Math.floor(Math.random() * 1e9),
  day: 1,
  started: false,
};

// Хост — первый подключившийся, авторитет по игровому миру
let hostId = null;

function broadcast(msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const [id, c] of clients) {
    if (id === exceptId) continue;
    if (c.ws.readyState === 1) c.ws.send(data);
  }
}
function sendTo(id, msg) {
  const c = clients.get(id);
  if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
  if (clients.size >= serverConfig.maxPlayers) {
    ws.send(JSON.stringify({type:'rejected', reason:'Комната заполнена'}));
    ws.close();
    return;
  }
  const id = nextId++;
  const client = {
    id, ws,
    name: 'Гость' + id,
    role: 'survivor',     // 'survivor' | 'maniac' (PvP)
    x: 0, y: 0, dir: 'down',
    hidden: false, inv: null,
    alive: true,
    lastSeen: Date.now(),
  };
  clients.set(id, client);

  if (hostId === null) hostId = id;

  console.log(`[+] Игрок #${id} подключился. Всего: ${clients.size}`);

  // Приветствие новому игроку
  ws.send(JSON.stringify({
    type: 'welcome',
    id,
    isHost: id === hostId,
    config: serverConfig,
    players: Array.from(clients.values()).map(c => ({
      id: c.id, name: c.name, role: c.role,
      x: c.x, y: c.y, dir: c.dir, hidden: c.hidden, inv: c.inv, alive: c.alive
    })),
  }));

  // Уведомляем остальных о новом игроке
  broadcast({
    type: 'playerJoin',
    player: {
      id: client.id, name: client.name, role: client.role,
      x: client.x, y: client.y, dir: client.dir,
    }
  }, id);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    client.lastSeen = Date.now();
    handleMessage(id, msg);
  });

  ws.on('close', () => {
    console.log(`[-] Игрок #${id} отключился. Осталось: ${clients.size-1}`);
    clients.delete(id);
    broadcast({type:'playerLeave', id});
    if (id === hostId) {
      // Передаём хост следующему игроку
      hostId = clients.keys().next().value || null;
      if (hostId) {
        sendTo(hostId, {type:'youAreHost'});
        broadcast({type:'newHost', id:hostId});
      }
    }
  });

  ws.on('error', () => {});
});

function handleMessage(senderId, msg) {
  const sender = clients.get(senderId);
  if (!sender) return;

  switch (msg.type) {
    case 'setName':
      sender.name = String(msg.name || '').substring(0, 20) || 'Гость' + senderId;
      broadcast({type:'playerUpdate', id:senderId, name:sender.name});
      break;

    case 'setMode':
      // Только хост может изменить режим до старта
      if (senderId !== hostId || serverConfig.started) return;
      if (msg.mode === 'coop' || msg.mode === 'pvp') {
        serverConfig.mode = msg.mode;
        broadcast({type:'configUpdate', config: serverConfig});
      }
      break;

    case 'setRole':
      // В PvP — назначить себя маньяком/жертвой (только хост)
      if (senderId !== hostId) return;
      const target = clients.get(msg.targetId);
      if (target && (msg.role === 'survivor' || msg.role === 'maniac')) {
        // Только один маньяк
        if (msg.role === 'maniac') {
          for (const c of clients.values()) if (c.role === 'maniac') c.role = 'survivor';
        }
        target.role = msg.role;
        broadcast({type:'playerUpdate', id:target.id, role:target.role});
      }
      break;

    case 'startGame':
      if (senderId !== hostId || serverConfig.started) return;
      serverConfig.started = true;
      serverConfig.worldSeed = Math.floor(Math.random() * 1e9);
      // В PvP-режиме если ни один не маньяк — назначаем хоста маньяком
      if (serverConfig.mode === 'pvp') {
        const hasManiac = Array.from(clients.values()).some(c => c.role === 'maniac');
        if (!hasManiac) {
          sender.role = 'maniac';
          broadcast({type:'playerUpdate', id:sender.id, role:'maniac'});
        }
      }
      broadcast({type:'gameStart', seed: serverConfig.worldSeed, mode: serverConfig.mode, day: serverConfig.day});
      break;

    case 'move':
      // Позиция игрока — рассылается всем
      sender.x = msg.x; sender.y = msg.y; sender.dir = msg.dir;
      sender.hidden = !!msg.hidden;
      sender.moving = !!msg.moving;
      sender.running = !!msg.running;
      broadcast({type:'move', id:senderId, x:msg.x, y:msg.y, dir:msg.dir,
                 hidden:sender.hidden, moving:sender.moving, running:sender.running}, senderId);
      break;

    case 'invUpdate':
      sender.inv = msg.inv || null;
      broadcast({type:'invUpdate', id:senderId, inv:sender.inv}, senderId);
      break;

    // === Авторитетные события: ретранслируем всем (включая отправителя для подтверждения) ===
    case 'action':
      // {action:'pickup'|'drop'|'open'|'search'|'doorProgress'|'hatch'|'fuse'|'generator'|'chest'|'trapSet'|'trapSnap'|'shoot'|'win',
      //  payload:{...}}
      broadcast({type:'action', from:senderId, action:msg.action, payload:msg.payload || {}});
      break;

    case 'sound':
      // Звук с координатами — для других игроков (шаги, выстрелы)
      broadcast({type:'sound', from:senderId, x:msg.x, y:msg.y, kind:msg.kind, vol:msg.vol||1}, senderId);
      break;

    case 'caught':
      // Жертва поймана (в PvP игрок-маньяк или бот). Отправитель — пойманный.
      sender.alive = false;
      broadcast({type:'caught', id:senderId, x:msg.x, y:msg.y, item:msg.item || null});
      break;

    case 'newDay':
      // Хост объявляет переход на новый день
      if (senderId !== hostId) return;
      serverConfig.day = msg.day;
      for (const c of clients.values()) c.alive = true;
      broadcast({type:'newDay', day: msg.day});
      break;

    case 'chat':
      broadcast({type:'chat', from:senderId, name:sender.name, text:String(msg.text||'').substring(0,200)});
      break;

    case 'ping':
      sendTo(senderId, {type:'pong', t: msg.t});
      break;
  }
}

// Чистка зависших клиентов
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.lastSeen > 30000) {
      try { c.ws.terminate(); } catch(e){}
    }
  }
}, 5000);

// ============================================================
// mDNS — автоанонс комнаты в локальной сети
// ============================================================
const bonjour = new Bonjour();
let publishedService = null;

function publishService() {
  if (publishedService) { try { publishedService.stop(); } catch(e){} }
  publishedService = bonjour.publish({
    name: serverConfig.roomName,
    type: 'maniachouse',
    port: PORT,
    txt: {
      host: serverConfig.hostName,
      mode: serverConfig.mode,
      players: String(clients.size),
      max: String(serverConfig.maxPlayers),
      version: '1',
    }
  });
  publishedService.on('up', () => console.log(`[mDNS] Анонс комнаты «${serverConfig.roomName}» опубликован`));
  publishedService.on('error', e => console.log('[mDNS] Ошибка:', e.message));
}

function getRoomList() {
  // Используется HTTP fallback для случая если mDNS заблокирован
  return [{
    name: serverConfig.roomName,
    host: serverConfig.hostName,
    mode: serverConfig.mode,
    players: clients.size,
    maxPlayers: serverConfig.maxPlayers,
    port: PORT,
  }];
}

// ============================================================
// СТАРТ
// ============================================================
function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          ДОМ ПАЛАЧА — МУЛЬТИПЛЕЕРНЫЙ СЕРВЕР                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Комната:    «${serverConfig.roomName}»`);
  console.log(`  Хост:        ${serverConfig.hostName}`);
  console.log(`  Порт:        ${PORT}`);
  console.log('');
  console.log('  Откройте в браузере (на этом ПК):');
  console.log(`    http://localhost:${PORT}`);
  console.log('');
  if (ips.length) {
    console.log('  Друзья в той же Wi-Fi сети могут зайти по адресу:');
    ips.forEach(ip => console.log(`    http://${ip}:${PORT}`));
    console.log('');
    console.log('  Либо просто открыть игру и выбрать «ОНЛАЙН» — комната найдётся сама.');
  }
  console.log('');
  console.log('  Чтобы остановить сервер: Ctrl+C');
  console.log('');
  publishService();
});

process.on('SIGINT', () => {
  console.log('\nОстановка сервера...');
  if (publishedService) try { publishedService.stop(); } catch(e){}
  bonjour.destroy();
  process.exit(0);
});

// Также запустим mDNS-браузер чтобы видеть СВОИ же комнаты в списке (для тестирования)
// и для последующего проксирования другим клиентам
const discoveredRooms = new Map(); // key: name → info
const browser = bonjour.find({ type: 'maniachouse' }, (service) => {
  // регистрируется (даже свой собственный сервис) — но в getRoomList мы это используем для других
});
browser.on('up', (service) => {
  discoveredRooms.set(service.name, {
    name: service.name,
    host: service.txt?.host || '?',
    mode: service.txt?.mode || 'coop',
    players: parseInt(service.txt?.players||'0',10),
    maxPlayers: parseInt(service.txt?.max||'4',10),
    addresses: service.addresses,
    port: service.port,
  });
});
browser.on('down', (service) => {
  discoveredRooms.delete(service.name);
});

// Расширим /rooms чтобы возвращал все найденные комнаты (включая удалённые)
const origGetRoomList = getRoomList;
function getAllRooms() {
  // Возвращаем себя + всё, что нашли через mDNS (могут быть дубли — клиент отфильтрует)
  const list = [];
  // свои
  list.push({
    name: serverConfig.roomName,
    host: serverConfig.hostName,
    mode: serverConfig.mode,
    players: clients.size,
    maxPlayers: serverConfig.maxPlayers,
    port: PORT,
    self: true,
  });
  for (const r of discoveredRooms.values()) {
    if (r.name === serverConfig.roomName) continue; // не дублируем себя
    list.push(r);
  }
  return list;
}
// Перехватываем эндпоинт
const origListener = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/rooms') {
    res.writeHead(200, {'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(getAllRooms()));
    return;
  }
  origListener.call(server, req, res);
});
