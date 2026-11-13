'use strict';

const socket = io();
const $ = (selector) => document.querySelector(selector);
const lobby = $('#lobby');
const roomView = $('#room');
const waitingPanel = $('#waiting-panel');
const playPanel = $('#play-panel');
const boardArea = $('#board-area');
const toastNode = $('#toast');

let gameState = null;
let session = readSession();
let toastTimer = null;

function readSession() {
  try { return JSON.parse(localStorage.getItem('blindMazeSession') || 'null'); }
  catch { return null; }
}

function saveSession(value) {
  session = value;
  if (value) localStorage.setItem('blindMazeSession', JSON.stringify(value));
  else localStorage.removeItem('blindMazeSession');
}

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('show'), 2600);
}

function setInRoom(inRoom) {
  lobby.hidden = inRoom;
  roomView.hidden = !inRoom;
}

function handleRoomFailure(message) {
  saveSession(null);
  gameState = null;
  setInRoom(false);
  toast(message || '无法进入房间。');
}

function startSessionResponse(response) {
  if (!response || !response.ok) {
    toast(response?.message || '操作失败，请重试。');
    return;
  }
  saveSession({ code: response.code, token: response.token });
  $('#room-code').textContent = response.code;
  setInRoom(true);
}

$('#create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#create-name').value.trim();
  socket.emit('create_room', { name }, startSessionResponse);
});

$('#join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#join-name').value.trim();
  const code = $('#join-code').value.trim().toUpperCase();
  if (!code) return toast('请先输入房间号码。');
  socket.emit('join_room', { name, code }, startSessionResponse);
});

socket.on('connect', () => {
  $('#connection-pill').textContent = '已连接';
  $('#connection-pill').classList.remove('offline');
  if (session?.code && session?.token) {
    socket.emit('resume_room', session, (response) => {
      if (!response?.ok) handleRoomFailure(response?.message);
      else setInRoom(true);
    });
  }
});

socket.on('disconnect', () => {
  $('#connection-pill').textContent = '连接中断';
  $('#connection-pill').classList.add('offline');
});

socket.on('connect_error', () => {
  $('#connection-pill').textContent = '连接失败';
  $('#connection-pill').classList.add('offline');
});

socket.on('state', (state) => {
  gameState = state;
  setInRoom(true);
  $('#room-code').textContent = state.code;
  renderState();
});

socket.on('toast', toast);
socket.on('room_closed', (message) => handleRoomFailure(message));

$('#copy-code').addEventListener('click', async () => {
  const code = $('#room-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    toast('房间号码已复制。');
  } catch {
    toast(`房间号码：${code}`);
  }
});

$('#leave-room').addEventListener('click', () => {
  if (!confirm('关闭这个房间？另一位玩家也会退出。')) return;
  socket.emit('leave_room', {}, () => {
    saveSession(null);
    gameState = null;
    setInRoom(false);
  });
});

$('#back-to-lobby').addEventListener('click', () => {
  socket.emit('leave_room', {}, () => {
    saveSession(null);
    gameState = null;
    setInRoom(false);
  });
});

$('#ready-button').addEventListener('click', () => socket.emit('ready'));

document.querySelectorAll('[data-direction]').forEach((button) => {
  button.addEventListener('click', () => move(button.dataset.direction));
});

boardArea.addEventListener('click', (event) => {
  const cell = event.target.closest('[data-cell]');
  if (!cell || !gameState) return;
  const index = Number(cell.dataset.cell);
  if (gameState.phase === 'setup') {
    const row = Math.floor(index / 12);
    const col = index % 12;
    socket.emit('toggle_wall', { row, col });
  } else if (gameState.phase === 'playing' && gameState.turn === gameState.me) {
    const current = gameState.position;
    const currentRow = Math.floor(current / 12);
    const currentCol = current % 12;
    const targetRow = Math.floor(index / 12);
    const targetCol = index % 12;
    if (targetRow === currentRow - 1 && targetCol === currentCol) move('up');
    else if (targetRow === currentRow + 1 && targetCol === currentCol) move('down');
    else if (targetRow === currentRow && targetCol === currentCol - 1) move('left');
    else if (targetRow === currentRow && targetCol === currentCol + 1) move('right');
  }
});

function move(direction) {
  if (!gameState || gameState.phase !== 'playing') return;
  socket.emit('move', { direction });
}

window.addEventListener('keydown', (event) => {
  if (gameState?.phase !== 'playing' || gameState.turn !== gameState.me) return;
  const keyMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const direction = keyMap[event.key];
  if (direction) {
    event.preventDefault();
    move(direction);
  }
});

function renderState() {
  const state = gameState;
  if (!state) return;

  const opponent = state.players[1 - state.me];
  $('#me-name').textContent = state.myName;
  $('#opponent-name').textContent = opponent?.name || '等待加入';
  $('#me-status').textContent = state.players[state.me].connected ? '在线' : '离线';
  $('#opponent-status').textContent = opponent?.connected ? (opponent.ready ? '已准备' : '在线') : (opponent?.name?.startsWith('等待') ? '未加入' : '离线');
  waitingPanel.hidden = state.phase !== 'waiting';
  playPanel.hidden = state.phase === 'waiting';

  if (state.phase === 'waiting') return;

  $('#notice').textContent = state.notice || '';
  $('#notice').classList.toggle('alert', state.notice === '你碰壁了！');

  if (state.phase === 'setup') {
    $('#phase-kicker').textContent = 'MAZE SETUP';
    $('#phase-title').textContent = '构筑你的迷宫';
    $('#phase-description').textContent = state.players[state.me].ready
      ? '你已经准备就绪，等待对手完成构筑。'
      : '点击格子放置墙壁，再次点击可以移除。';
    $('#timer-label').textContent = '构筑剩余';
    $('#setup-controls').hidden = false;
    $('#move-controls').hidden = true;
    $('#result-panel').hidden = true;
    $('#ready-button').disabled = state.players[state.me].ready;
    $('#ready-button').textContent = state.players[state.me].ready ? '已准备就绪' : '已准备就绪';
    $('#ready-hint').textContent = state.players[1 - state.me].ready ? '对手已经准备好了。' : '双方都准备好后，立即开始游戏。';
    renderBoard(boardArea, { walls: new Set(state.ownWalls), editable: !state.players[state.me].ready, caption: '你的迷宫 · 对手暂时看不到这里的墙壁' });
    updateTimer();
  } else if (state.phase === 'playing') {
    $('#phase-kicker').textContent = 'BLIND WALK';
    $('#phase-title').textContent = state.turn === state.me ? '轮到你行动' : '等待对手行动';
    $('#phase-description').textContent = `正在探索 ${state.targetPlayerName} 的迷宫。每次只能移动一格。`;
    $('#timer-label').textContent = '当前回合';
    $('#timer').textContent = state.turn === state.me ? '你的回合' : '对手回合';
    $('#setup-controls').hidden = true;
    $('#move-controls').hidden = false;
    $('#result-panel').hidden = true;
    renderBoard(boardArea, {
      walls: new Set(state.revealedWalls),
      position: state.position,
      playing: true,
      caption: `对手的迷宫 · 已发现墙壁 ${state.revealedWalls.length} 块`
    });
    document.querySelectorAll('.direction-pad button').forEach((button) => {
      button.disabled = state.turn !== state.me;
      button.style.opacity = state.turn === state.me ? '1' : '.4';
    });
  } else if (state.phase === 'finished') {
    $('#phase-kicker').textContent = 'GAME OVER';
    $('#phase-title').textContent = '本局结束';
    $('#phase-description').textContent = '双方迷宫现已完全公开。';
    $('#timer-label').textContent = '最终结果';
    $('#timer').textContent = state.winner === state.me ? '胜利' : '结束';
    $('#setup-controls').hidden = true;
    $('#move-controls').hidden = true;
    $('#result-panel').hidden = false;
    const won = state.winner === state.me;
    $('#result-title').textContent = won ? '恭喜，你赢了！' : '对手先到达终点';
    $('#result-description').textContent = won ? '你成功穿过对方的迷宫，抵达了（12，12）。' : '这次没能抢先抵达终点，再来一局吧。';
    $('#reveal-mazes').innerHTML = '';
    const own = state.me;
    const other = 1 - own;
    const ownCard = document.createElement('div');
    ownCard.className = 'reveal-card';
    ownCard.innerHTML = `<h3>你的迷宫 · ${escapeHtml(state.players[own].name)}</h3><div class="mini-board"></div>`;
    const otherCard = document.createElement('div');
    otherCard.className = 'reveal-card';
    otherCard.innerHTML = `<h3>对手的迷宫 · ${escapeHtml(state.players[other].name)}</h3><div class="mini-board"></div>`;
    $('#reveal-mazes').append(ownCard, otherCard);
    renderBoard(ownCard.querySelector('.mini-board'), { walls: new Set(state.mazes[own]), caption: '' });
    renderBoard(otherCard.querySelector('.mini-board'), { walls: new Set(state.mazes[other]), caption: '' });
  }
}

function renderBoard(container, options) {
  const walls = options.walls || new Set();
  const position = options.position;
  const editable = Boolean(options.editable);
  const caption = options.caption || '';
  const frame = document.createElement('div');
  if (caption) {
    const label = document.createElement('div');
    label.className = 'board-caption';
    label.textContent = caption;
    container.replaceChildren(label);
  } else {
    container.replaceChildren();
  }
  frame.className = 'board-frame';

  const corner = document.createElement('div');
  corner.className = 'coord-corner';
  frame.appendChild(corner);

  const top = document.createElement('div');
  top.className = 'coord-top';
  for (let col = 1; col <= 12; col += 1) {
    const n = document.createElement('span');
    n.textContent = col;
    top.appendChild(n);
  }
  frame.appendChild(top);

  const side = document.createElement('div');
  side.className = 'coord-side';
  for (let row = 1; row <= 12; row += 1) {
    const n = document.createElement('span');
    n.textContent = row;
    side.appendChild(n);
  }
  frame.appendChild(side);

  const grid = document.createElement('div');
  grid.className = `maze-grid${editable ? ' editable' : ''}`;
  for (let index = 0; index < 144; index += 1) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.cell = String(index);
    const isStart = index === 0;
    const isGoal = index === 143;
    const isWall = walls.has(index);
    const isCurrent = position === index;
    if (isWall) cell.classList.add('wall');
    if (isStart) cell.classList.add('start');
    if (isGoal) cell.classList.add('goal');
    if (isCurrent) cell.classList.add('current');
    if (isStart) cell.textContent = 'S';
    else if (isGoal) cell.textContent = 'G';
    else if (isCurrent) cell.setAttribute('aria-label', '你当前的位置');
    else if (isWall && !editable) cell.setAttribute('aria-label', '已发现的墙壁');
    else if (isWall) cell.setAttribute('aria-label', '墙壁');
    else cell.setAttribute('aria-label', `第${Math.floor(index / 12) + 1}行，第${index % 12 + 1}列`);
    grid.appendChild(cell);
  }
  frame.appendChild(grid);
  container.appendChild(frame);
}

function updateTimer() {
  if (!gameState || gameState.phase !== 'setup' || !gameState.deadline) return;
  const seconds = Math.max(0, Math.ceil((gameState.deadline - Date.now()) / 1000));
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  const rest = String(seconds % 60).padStart(2, '0');
  $('#timer').textContent = `${minutes}:${rest}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

setInterval(updateTimer, 250);
