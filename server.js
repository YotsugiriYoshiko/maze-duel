'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const SIZE = 12;
const CELL_COUNT = SIZE * SIZE;
const START = 0;
const GOAL = CELL_COUNT - 1;
const SETUP_MS = 60_000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function cleanName(value, fallback) {
  const name = String(value || '').trim().slice(0, 16);
  return name || fallback;
}

function hasPath(walls) {
  if (walls.has(START) || walls.has(GOAL)) return false;

  const visited = new Uint8Array(CELL_COUNT);
  const queue = [START];
  visited[START] = 1;
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    if (current === GOAL) return true;

    const row = Math.floor(current / SIZE);
    const col = current % SIZE;
    const neighbours = [
      row > 0 ? current - SIZE : -1,
      row < SIZE - 1 ? current + SIZE : -1,
      col > 0 ? current - 1 : -1,
      col < SIZE - 1 ? current + 1 : -1
    ];

    for (const next of neighbours) {
      if (next < 0 || visited[next] || walls.has(next)) continue;
      visited[next] = 1;
      queue.push(next);
    }
  }
  return false;
}

function getPlayerIndex(room, socket) {
  return room.players.findIndex((player) =>
    player && player.token === socket.data.token && player.socketId === socket.id
  );
}

function snapshotFor(room, playerIndex) {
  const me = room.players[playerIndex];
  const snapshot = {
    code: room.code,
    phase: room.phase,
    me: playerIndex,
    myName: me.name,
    players: room.players.map((player, index) => ({
      name: player ? player.name : `等待玩家${index + 1}`,
      connected: Boolean(player && player.socketId),
      ready: Boolean(player && player.ready)
    })),
    deadline: room.deadline,
    turn: room.turn,
    firstPlayer: room.firstPlayer,
    winner: room.winner,
    notice: room.notices[playerIndex]
  };

  if (room.phase === 'waiting' || room.phase === 'setup') {
    // During setup, each player receives only their own maze.
    snapshot.ownWalls = Array.from(me.walls);
  } else if (room.phase === 'playing') {
    // During play, each player receives only the walls they have personally discovered.
    snapshot.position = room.positions[playerIndex];
    snapshot.revealedWalls = Array.from(room.revealed[playerIndex]);
    snapshot.targetPlayerName = room.players[1 - playerIndex].name;
    snapshot.moves = room.moves[playerIndex];
  } else if (room.phase === 'finished') {
    // Full mazes are disclosed only after the game is over.
    snapshot.mazes = room.players.map((player) => Array.from(player.walls));
    snapshot.positions = room.positions.slice();
    snapshot.moves = room.moves.slice();
  }

  return snapshot;
}

function sendRoomState(room) {
  room.players.forEach((player, index) => {
    if (player && player.socketId) {
      io.to(player.socketId).emit('state', snapshotFor(room, index));
    }
  });
}

function sendToast(socket, message) {
  socket.emit('toast', message);
}

function closeRoom(room, message) {
  if (room.setupTimer) clearTimeout(room.setupTimer);
  for (const player of room.players) {
    if (player && player.socketId) {
      io.to(player.socketId).emit('room_closed', message);
    }
  }
  rooms.delete(room.code);
}

function beginGame(room) {
  if (room.phase !== 'setup') return;
  if (room.setupTimer) clearTimeout(room.setupTimer);
  room.setupTimer = null;
  room.phase = 'playing';
  room.players.forEach((player) => { if (player) player.ready = true; });
  room.firstPlayer = crypto.randomInt(2);
  room.turn = room.firstPlayer;
  room.positions = [START, START];
  room.revealed = [new Set(), new Set()];
  room.moves = [0, 0];
  room.notices = ['游戏开始！你先行动。', '游戏开始！等待对手行动。'];
  sendRoomState(room);
}

function maybeStartSetup(room) {
  if (!room.players[0] || !room.players[1] || room.phase !== 'waiting') return;
  room.phase = 'setup';
  room.deadline = Date.now() + SETUP_MS;
  room.setupTimer = setTimeout(() => beginGame(room), SETUP_MS);
  sendRoomState(room);
}

function bindSocket(socket, room, playerIndex) {
  const player = room.players[playerIndex];
  player.socketId = socket.id;
  socket.data.roomCode = room.code;
  socket.data.token = player.token;
  socket.join(room.code);
}

io.on('connection', (socket) => {
  socket.on('create_room', (payload = {}, ack = () => {}) => {
    const code = makeCode();
    const player = {
      token: makeToken(),
      name: cleanName(payload.name, '玩家1'),
      socketId: null,
      walls: new Set(),
      ready: false
    };
    const room = {
      code,
      phase: 'waiting',
      players: [player, null],
      deadline: null,
      setupTimer: null,
      turn: null,
      firstPlayer: null,
      winner: null,
      positions: [START, START],
      revealed: [new Set(), new Set()],
      moves: [0, 0],
      notices: ['', '']
    };
    rooms.set(code, room);
    bindSocket(socket, room, 0);
    ack({ ok: true, code, token: player.token, me: 0 });
    sendRoomState(room);
  });

  socket.on('join_room', (payload = {}, ack = () => {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, message: '找不到这个房间，请检查房间号。' });
    if (room.phase !== 'waiting' || room.players[1]) {
      return ack({ ok: false, message: '这个房间已经开始或已满员。' });
    }

    const player = {
      token: makeToken(),
      name: cleanName(payload.name, '玩家2'),
      socketId: null,
      walls: new Set(),
      ready: false
    };
    room.players[1] = player;
    bindSocket(socket, room, 1);
    ack({ ok: true, code, token: player.token, me: 1 });
    maybeStartSetup(room);
  });

  socket.on('resume_room', (payload = {}, ack = () => {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const token = String(payload.token || '');
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, message: '房间已经失效，请重新创建。' });
    const playerIndex = room.players.findIndex((player) => player && player.token === token);
    if (playerIndex < 0) return ack({ ok: false, message: '房间身份验证失败。' });

    bindSocket(socket, room, playerIndex);
    ack({ ok: true, code, token, me: playerIndex });
    sendRoomState(room);
  });

  socket.on('toggle_wall', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const playerIndex = getPlayerIndex(room, socket);
    if (playerIndex < 0) return;
    const player = room.players[playerIndex];

    if (room.phase !== 'setup') return sendToast(socket, '现在不是构筑迷宫的时间。');
    if (Date.now() >= room.deadline) {
      beginGame(room);
      return;
    }
    if (player.ready) return sendToast(socket, '你已经准备就绪，不能再修改迷宫。');

    const row = Number(payload.row);
    const col = Number(payload.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= SIZE || col < 0 || col >= SIZE) {
      return sendToast(socket, '无效的格子。');
    }

    const cell = row * SIZE + col;
    if (cell === START || cell === GOAL) {
      return sendToast(socket, '不可封死道路：起点和终点不能放置墙壁。');
    }

    if (player.walls.has(cell)) {
      player.walls.delete(cell);
      sendRoomState(room);
      return;
    }

    player.walls.add(cell);
    if (!hasPath(player.walls)) {
      player.walls.delete(cell);
      return sendToast(socket, '不可封死道路：必须保留从起点到终点的通路。');
    }
    sendRoomState(room);
  });

  socket.on('ready', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const playerIndex = getPlayerIndex(room, socket);
    if (playerIndex < 0) return;
    if (room.phase !== 'setup') return sendToast(socket, '现在还不能准备。');
    if (Date.now() >= room.deadline) {
      beginGame(room);
      return;
    }

    room.players[playerIndex].ready = true;
    room.notices[playerIndex] = '你已准备就绪，等待对方。';
    if (room.players.every((player) => player && player.ready)) {
      beginGame(room);
    } else {
      sendRoomState(room);
    }
  });

  socket.on('move', (payload = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const playerIndex = getPlayerIndex(room, socket);
    if (playerIndex < 0) return;
    if (room.phase !== 'playing') return sendToast(socket, '现在不能移动。');
    if (room.turn !== playerIndex) return sendToast(socket, '还没轮到你行动。');

    const deltaByDirection = {
      up: [-1, 0],
      down: [1, 0],
      left: [0, -1],
      right: [0, 1]
    };
    const delta = deltaByDirection[payload.direction];
    if (!delta) return sendToast(socket, '无效的移动方向。');

    const current = room.positions[playerIndex];
    const row = Math.floor(current / SIZE) + delta[0];
    const col = (current % SIZE) + delta[1];
    if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) {
      room.notices[playerIndex] = '已经到达棋盘边缘。';
      sendRoomState(room);
      return;
    }

    const next = row * SIZE + col;
    const opponentMaze = room.players[1 - playerIndex].walls;
    room.moves[playerIndex] += 1;

    if (opponentMaze.has(next)) {
      room.revealed[playerIndex].add(next);
      room.notices[playerIndex] = '你碰壁了！';
      room.turn = 1 - playerIndex;
    } else {
      room.positions[playerIndex] = next;
      room.notices[playerIndex] = '前进成功。';
      if (next === GOAL) {
        room.phase = 'finished';
        room.winner = playerIndex;
        room.notices[playerIndex] = '恭喜，你到达终点了！';
        room.notices[1 - playerIndex] = `${room.players[playerIndex].name}到达终点，游戏结束。`;
      } else {
        room.turn = 1 - playerIndex;
      }
    }

    if (room.phase === 'playing') {
      room.notices[1 - playerIndex] = `${room.players[playerIndex].name}已经行动，轮到你了。`;
    }
    sendRoomState(room);
  });

  socket.on('leave_room', (_payload, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (room) closeRoom(room, '有玩家离开，房间已关闭。');
    socket.data.roomCode = null;
    socket.data.token = null;
    ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const playerIndex = room.players.findIndex((player) => player && player.socketId === socket.id);
    if (playerIndex >= 0) {
      room.players[playerIndex].socketId = null;
      sendRoomState(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Blind Maze Duel is running on port ${PORT}`);
});
