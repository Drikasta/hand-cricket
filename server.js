'use strict';

const WebSocket = require('ws');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

// ── Config ───────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const MAX_BALLS     = 6;          // balls per innings
const PICK_MS       = 8500;       // server pick deadline (ms) — must exceed bot max think delay (4.5s) so bot always gets a turn
const REVEAL_MS     = 1500;       // pause after reveal before next round
const BREAK_MS      = 3000;       // innings break pause

// ── Bot pool ───────────────────────────────────────────────────────────────
const BOT_POOL = [
  { name: 'Arjun K.',  avatarIdx: 0 },
  { name: 'Priya S.',  avatarIdx: 1 },
  { name: 'Vikram R.', avatarIdx: 2 },
  { name: 'Ananya M.', avatarIdx: 3 },
  { name: 'Rohit D.',  avatarIdx: 4 },
  { name: 'Sneha P.',  avatarIdx: 5 },
  { name: 'Arnav T.',  avatarIdx: 6 },
  { name: 'Kavya N.',  avatarIdx: 7 },
  { name: 'Ishaan V.', avatarIdx: 0 },
  { name: 'Riya G.',   avatarIdx: 1 },
  { name: 'Aditya B.', avatarIdx: 2 },
  { name: 'Myra H.',   avatarIdx: 3 },
  { name: 'Aryan C.',  avatarIdx: 4 },
  { name: 'Diya F.',   avatarIdx: 5 },
  { name: 'Kabir W.',  avatarIdx: 6 },
  { name: 'Tanvi J.',  avatarIdx: 7 },
  { name: 'Shayan L.', avatarIdx: 0 },
  { name: 'Nisha Q.',  avatarIdx: 1 },
  { name: 'Faizan Z.', avatarIdx: 2 },
  { name: 'Sara O.',   avatarIdx: 3 },
];

// ── MIME types ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css',
  '.js'  : 'application/javascript',
  '.ico' : 'image/x-icon',
  '.svg' : 'image/svg+xml',
  '.json': 'application/json',
};

// ── HTTP static file server ──────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0].replace(/\.\./g, '');
  const filePath = path.join(__dirname, 'public', urlPath === '/' ? 'index.html' : urlPath);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── Room store ───────────────────────────────────────────────────────────────
// rooms: Map<code:string, Room>
const rooms = new Map();

function genCode() {
  let c;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  do { c = Array.from({length:6}, ()=>chars[Math.random()*chars.length|0]).join(''); }
  while (rooms.has(c));
  return c;
}

function makeRoom(code, isSolo = false) {
  return {
    code,
    players     : [],
    state       : 'waiting',
    isSolo,
    botIdx      : null,
    batter      : null,
    innings     : 1,
    scores      : [0, 0],
    history     : [[], []],
    pickTimer   : null,
    roundResolved: false,
    // botMemory tracks human player's picks in each role so the bot can counter
    botMemory   : {
      playerHistory: [],      // all human picks across current innings
      playerBowlingHistory: [], // human's bowling picks (bot batting)
      playerBattingHistory: [], // human's batting picks (bot bowling)
      thinkDelay: 0,
    },
  };
}

function makePlayer(name, ws, idx, isBot = false, avatarIdx = 0) {
  return { name, ws, idx, isBot, avatarIdx, pick: null, picked: false };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(room, obj) {
  room.players.forEach(p => send(p.ws, obj));
}

function broadcastExcept(room, obj, excludeIdx) {
  room.players.forEach((p, i) => { if (i !== excludeIdx) send(p.ws, obj); });
}

// ── Bot AI ──────────────────────────────────────────────────────────────────
// Returns a pick based on smarter analysis:
// - When bot is batting: try to match the human bowler's pattern (track what human bowls)
// - When bot is bowling: try to counter the human batsman's pattern
function computeBotPick(room) {
  const humanIdx   = 1 - room.botIdx;
  const botIsBatter = room.batter === room.botIdx;

  // Separate tracking of picks by role
  if (botIsBatter) {
    // Bot is batting — track what human bowler has been picking
    const humanBowlingHistory = room.botMemory.playerBowlingHistory;
    const recentBowling = humanBowlingHistory.slice(-8);
    if (recentBowling.length >= 3) {
      const freq = {};
      recentBowling.forEach(n => { freq[n] = (freq[n] || 0) + 1; });
      const mostPicked = parseInt(Object.entries(freq)
        .sort((a, b) => b[1] - a[1])[0][0], 10);
      // 55% chance: predict most picked, match it to get OUT
      if (Math.random() < 0.55) return mostPicked;
    }
  } else {
    // Bot is bowling — track what human batsman has been picking
    const humanBattingHistory = room.botMemory.playerBattingHistory;
    const recentBatting = humanBattingHistory.slice(-8);
    if (recentBatting.length >= 3) {
      const freq = {};
      recentBatting.forEach(n => { freq[n] = (freq[n] || 0) + 1; });
      const mostPicked = parseInt(Object.entries(freq)
        .sort((a, b) => b[1] - a[1])[0][0], 10);
      // 55% chance: match the human's most-picked number to get them OUT
      if (Math.random() < 0.55) return mostPicked;
    }
    // Human batsman has scored big — 25% hard deflection (pick uncommon number)
    if (recentBatting.length >= 4) {
      const recentRuns = recentBatting.filter(v => v !== 'W' && typeof v === 'number');
      if (recentRuns.length >= 2) {
        const avg = recentRuns.reduce((a, b) => a + b, 0) / recentRuns.length;
        if (avg >= 4.5 && Math.random() < 0.25) {
          const common = Object.keys(freq).map(Number);
          const uncommon = [1,2,3,4,5,6].filter(n => !common.includes(n));
          if (uncommon.length > 0) return uncommon[Math.random() * uncommon.length | 0];
        }
      }
    }
  }

  // Fallback 1 (20%): pure random to feel unpredictable
  if (Math.random() < 0.20) return (Math.random() * 6 | 0) + 1;

  // Fallback 2: safe pick — avoid numbers human just played recently
  const allRecent = room.botMemory.playerHistory.slice(-5);
  if (allRecent.length > 0) {
    const safe = [1, 2, 3, 4, 5, 6].filter(n => !allRecent.includes(n));
    if (safe.length > 0 && Math.random() < 0.45) {
      return safe[Math.random() * safe.length | 0];
    }
  }

  return (Math.random() * 6 | 0) + 1;
}

// Track human's pick by role so bot can build a counter-profile
function recordHumanPick(room, humanPick) {
  if (typeof humanPick !== 'number') return;
  room.botMemory.playerHistory.push(humanPick);
  if (room.batter === 1 - room.botIdx) {
    // Human is batting (bot is bowler)
    room.botMemory.playerBattingHistory.push(humanPick);
  } else {
    // Human is bowling (bot is batsman)
    room.botMemory.playerBowlingHistory.push(humanPick);
  }
}

function runBotPick(room) {
  const bot = room.players[room.botIdx];
  if (!bot || bot.picked || room.state !== 'playing') return;

  const thinkDelay = 1500 + Math.random() * 3000; // 1.5–4.5s

  room.botMemory.thinkDelay = thinkDelay;

  setTimeout(() => {
    if (room.state !== 'playing') return;
    if (bot.picked) return;

    const pick = computeBotPick(room);
    bot.pick   = pick;
    bot.picked = true;

    const humanIdx = 1 - room.botIdx;
    if (room.players[humanIdx].ws) {
      send(room.players[humanIdx].ws, { type: 'opponent_picked' });
    }

    checkBothPicked(room);
  }, thinkDelay);
}

// ── Round ────────────────────────────────────────────────────────────────────
function beginRound(room) {
  room.players.forEach(p => { p.pick = null; p.picked = false; });
  clearTimeout(room.pickTimer);
  room.roundResolved = false;

  broadcast(room, {
    type    : 'round_start',
    batter  : room.batter,
    innings : room.innings,
    scores  : room.scores,
    history : room.history,
    target  : room.innings === 2 ? room.scores[1 - room.batter] + 1 : null,
  });

  room.pickTimer = setTimeout(() => resolveRound(room), PICK_MS);

  // Trigger bot pick whenever bot is involved (bowler OR batter)
  if (room.isSolo) {
    const bowler = 1 - room.batter;
    if (room.players[bowler].isBot) {
      runBotPick(room);
    }
    if (room.players[room.batter].isBot) {
      runBotPick(room);
    }
  }
}

function resolveRound(room) {
  clearTimeout(room.pickTimer);
  if (room.state !== 'playing') return;
  if (room.roundResolved) return;
  room.roundResolved = true;

  const batter  = room.batter;
  const bowler  = 1 - batter;
  const bPick   = room.players[batter].pick;
  const wPick   = room.players[bowler].pick;

  // If either didn't pick in time → dot ball, no wicket, no runs
  if (bPick === null || wPick === null) {
    room.history[batter].push('?');
    if (room.isSolo && bPick !== null) recordHumanPick(room, bPick);
    if (room.isSolo && wPick !== null) recordHumanPick(room, wPick);
    // runs stays 0, scores unchanged

    broadcast(room, {
      type       : 'round_result',
      batterPick : bPick,
      bowlerPick : wPick,
      isOut      : false,
      runs       : 0,
      scores     : room.scores,
      history    : room.history,
      batter,
    });

    const ballsPlayed = room.history[batter].length;
    const inningsOver = ballsPlayed >= MAX_BALLS;
    if (room.innings === 2 && room.scores[batter] >= room.scores[1 - batter] + 1) {
      setTimeout(() => endInnings(room), REVEAL_MS);
    } else if (inningsOver) {
      setTimeout(() => endInnings(room), REVEAL_MS);
    } else {
      setTimeout(() => beginRound(room), REVEAL_MS);
    }
    return;
  }

  const isOut = bPick === wPick;
  const runs  = isOut ? 0 : bPick;

  room.scores[batter] += runs;
  room.history[batter].push(isOut ? 'W' : bPick);

  // Track human picks for bot's counter-strategy
  if (room.isSolo) {
    recordHumanPick(room, room.players[1 - room.botIdx].pick);
  }

  broadcast(room, {
    type       : 'round_result',
    batterPick : bPick,
    bowlerPick : wPick,
    isOut,
    runs,
    scores     : room.scores,
    history    : room.history,
    batter,
  });

  const ballsPlayed = room.history[batter].length;
  const inningsOver = isOut || ballsPlayed >= MAX_BALLS;
  const target = room.innings === 2 ? room.scores[1 - batter] + 1 : Infinity;
  const targetMet = room.innings === 2 && room.scores[batter] >= target;

  if (inningsOver || targetMet) {
    setTimeout(() => endInnings(room), REVEAL_MS);
  } else {
    setTimeout(() => beginRound(room), REVEAL_MS);
  }
}

function checkBothPicked(room) {
  if (room.players[0].picked && room.players[1].picked) {
    clearTimeout(room.pickTimer);
    // Guard: don't double-resolve if the timeout already resolved this round
    if (room.roundResolved) return;
    // Slight delay so both clients receive their ack before result
    setTimeout(() => {
      if (room.roundResolved) return;
      resolveRound(room);
    }, 300);
  }
}

// ── Innings ──────────────────────────────────────────────────────────────────
function endInnings(room) {
  if (room.innings === 1) {
    room.innings = 2;
    room.batter  = 1 - room.batter;   // swap roles
    const target = room.scores[1 - room.batter] + 1;

    broadcast(room, {
      type    : 'innings_break',
      target,
      scores  : room.scores,
      history : room.history,
      playerNames : room.players.map(p => p.name),
    });

    room.state = 'innings_break';
    setTimeout(() => {
      room.state = 'playing';
      beginRound(room);
    }, BREAK_MS);
  } else {
    endGame(room);
  }
}

function endGame(room) {
  clearTimeout(room.pickTimer);
  room.state = 'finished';
  console.log('[END] game_over → winner:', room.scores[0] > room.scores[1] ? 0 : room.scores[1] > room.scores[0] ? 1 : 'draw', 'scores:', room.scores);

  const [s0, s1] = room.scores;
  const winner   = s0 > s1 ? 0 : s1 > s0 ? 1 : null;

  room.players.forEach((p, i) => {
    send(p.ws, {
      type        : 'game_over',
      winner,
      youWon      : winner === i,
      isDraw      : winner === null,
      scores      : room.scores,
      history     : room.history,
      playerNames : room.players.map(q => q.name),
    });
  });
}

// ── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', ws => {
  let roomCode   = null;
  let playerIdx  = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── create ──
    if (msg.type === 'create') {
      const name = String(msg.name || '').trim().slice(0, 14) || 'Player 1';
      const code = genCode();
      const room = makeRoom(code);
      room.players.push(makePlayer(name, ws, 0));
      rooms.set(code, room);
      roomCode  = code;
      playerIdx = 0;
      send(ws, { type: 'room_created', code, playerIndex: 0 });
      return;
    }

    // ── join ──
    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      const name = String(msg.name || '').trim().slice(0, 14) || 'Player 2';
      const room = rooms.get(code);

      if (!room)                    { send(ws, { type: 'error', message: 'Room not found. Check the code.' }); return; }
      if (room.players.length >= 2) { send(ws, { type: 'error', message: 'Room is full.' }); return; }
      if (room.state !== 'waiting') { send(ws, { type: 'error', message: 'Game already started.' }); return; }

      room.players.push(makePlayer(name, ws, 1));
      roomCode  = code;
      playerIdx = 1;

      send(ws, { type: 'room_joined', playerIndex: 1, opponentName: room.players[0].name });
      send(room.players[0].ws, { type: 'opponent_joined', opponentName: name });

      room.batter = 0;   // player 0 bats, player 1 bowls
      room.state  = 'playing';
      broadcast(room, {
        type        : 'game_start',
        batter      : room.batter,
        playerNames : room.players.map(p => p.name),
      });
      setTimeout(() => beginRound(room), 800);
      return;
    }

    // ── solo ──
    if (msg.type === 'solo') {
      const name = String(msg.name || '').trim().slice(0, 14) || 'Player 1';
      const code = genCode();
      const room = makeRoom(code, true);
      const botIdentity = BOT_POOL[Math.random() * BOT_POOL.length | 0];
      room.players.push(makePlayer(name, ws, 0));
      room.botIdx = 1;
      room.players.push(makePlayer(botIdentity.name, null, 1, true, botIdentity.avatarIdx));
      rooms.set(code, room);
      roomCode  = code;
      playerIdx = 0;
      send(ws, { type: 'solo_room_created', code, playerIndex: 0, botName: botIdentity.name, botAvatarIdx: botIdentity.avatarIdx });

      // Randomise who bats first (50/50)
      room.batter = Math.random() < 0.5 ? 0 : 1;
      room.state  = 'playing';
      send(ws, {
        type        : 'game_start',
        batter      : room.batter,
        playerNames : room.players.map(p => p.name),
        isSolo      : true,
        botAvatarIdx: botIdentity.avatarIdx,
      });
      setTimeout(() => beginRound(room), 800);
      return;
    }

    // ── pick ──
    if (msg.type === 'pick') {
      const room = rooms.get(roomCode);
      if (!room || room.state !== 'playing') return;

      const num = parseInt(msg.number, 10);
      if (num < 1 || num > 6) return;

      const player = room.players[playerIdx];
      if (player.picked) return;   // ignore double-picks

      player.pick   = num;
      player.picked = true;

      send(ws, { type: 'pick_ack', number: num });
      broadcastExcept(room, { type: 'opponent_picked' }, playerIdx);

      checkBothPicked(room);
      return;
    }

    // ── play_again ──
    if (msg.type === 'play_again') {
      const room = rooms.get(roomCode);
      if (!room || room.state !== 'finished') return;

      room.batter        = null;
      room.innings       = 1;
      room.scores        = [0, 0];
      room.history       = [[], []];
      room.roundResolved = false;
      room.botMemory     = { playerHistory: [], playerBowlingHistory: [], playerBattingHistory: [], thinkDelay: 0 };
      room.players.forEach(p => { p.pick = null; p.picked = false; });

      if (room.isSolo) {
        // Re-assign fresh bot identity
        const botIdentity = BOT_POOL[Math.random() * BOT_POOL.length | 0];
        room.players[room.botIdx] = makePlayer(botIdentity.name, null, room.botIdx, true, botIdentity.avatarIdx);
        // Randomise who bats first
        room.batter = Math.random() < 0.5 ? 0 : 1;
        room.state  = 'playing';
        send(room.players[0].ws, {
          type        : 'game_start',
          batter      : room.batter,
          playerNames : room.players.map(p => p.name),
          isSolo      : true,
          botAvatarIdx: botIdentity.avatarIdx,
        });
        setTimeout(() => beginRound(room), 800);
      } else {
        // Multiplayer: reset to waiting, host re-creates the flow
        room.state = 'waiting';
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    clearTimeout(room.pickTimer);

    if (room.isSolo && room.state !== 'finished') {
      // End the solo game gracefully — notify the human player
      const humanIdx = 1 - room.botIdx;
      if (room.players[humanIdx].ws) {
        send(room.players[humanIdx].ws, { type: 'solo_ended' });
      }
    } else if (room.state !== 'finished') {
      broadcastExcept(room, { type: 'opponent_disconnected' }, playerIdx);
    }

    rooms.delete(roomCode);
  });

  ws.on('error', () => {});
});

httpServer.listen(PORT, () => {
  console.log(`\n🏏  Hand Cricket running at http://localhost:${PORT}\n`);
});
