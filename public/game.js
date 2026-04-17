'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const TIMER_TOTAL   = 3;    // client-side countdown seconds
const REVEAL_MS     = 1500; // must match server REVEAL_MS
const CIRCUMFERENCE = 132;  // 2π * r (r=21)
const AVATARS       = ['🏙️','🌆','🏖️','⛰️','🌃','🏕️','🌉','🏔️'];

// ── State ──────────────────────────────────────────────────────────────────
let ws             = null;
let playerIndex    = null;   // 0 or 1
let myName         = '';
let playerNames    = ['', ''];
let currentBatter  = null;
let innings        = 1;
let scores         = [0, 0];
let history        = [[], []];
let myPick         = null;
let pickLocked     = false;
let timerID        = null;
let timerLeft      = TIMER_TOTAL;
let botAvatarIdx   = null;  // set by server for solo mode
let gameOver       = false; // set when game ends — blocks beginNextRound

// ── Sound System ───────────────────────────────────────────────────────────
let audioCtx       = null;
let soundsMuted   = false;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function sfx({ type = 'sine', freq = 440, freqEnd, duration = 0.2,
               gain = 0.25, gainEnd = 0, attack = 0.01, release = 0.1,
               noise = false, playbackRate = 1 } = {}) {
  if (soundsMuted) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const dur = duration / playbackRate;

  const gainNode = ctx.createGain();
  gainNode.connect(ctx.destination);
  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.linearRampToValueAtTime(gain, now + attack);
  gainNode.gain.setValueAtTime(gain, now + dur - release);
  gainNode.gain.linearRampToValueAtTime(gainEnd, now + dur);

  if (noise) {
    const bufSize = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = playbackRate;
    src.connect(gainNode);
    src.start(now);
    src.stop(now + dur);
    return;
  }

  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(freqEnd, now + dur);
  osc.connect(gainNode);
  osc.start(now);
  osc.stop(now + dur);
}

// ── Ambient background crowd (runs at very low volume during game) ────────
let ambientCrowd = null;

function startAmbientCrowd() {
  if (ambientCrowd || soundsMuted) return;
  const ctx = getAudioCtx();
  const dur = 8;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const t = i / d.length;
    // Low continuous murmur with subtle swell
    d[i] = (Math.random() * 2 - 1) * Math.sin(t * Math.PI * 0.5) * 0.3;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 200;
  const g = ctx.createGain();
  g.gain.value = 0.03;
  src.connect(lp);
  lp.connect(g);
  g.connect(ctx.destination);
  src.start();
  ambientCrowd = src;
}

function stopAmbientCrowd() {
  if (ambientCrowd) {
    try { ambientCrowd.stop(); } catch {}
    ambientCrowd = null;
  }
}

function soundPick() {
  sfx({ type: 'triangle', freq: 660, freqEnd: 520, duration: 0.06, gain: 0.12, attack: 0.003, release: 0.04 });
}

function soundBatHit() {
  if (soundsMuted) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;

  // Layer 1: Leather impact — bandpass-filtered noise burst
  const bufSize = Math.ceil(ctx.sampleRate * 0.25);
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const noiseSrc = ctx.createBufferSource();
  noiseSrc.buffer = buf;

  const bpFilter = ctx.createBiquadFilter();
  bpFilter.type = 'bandpass';
  bpFilter.frequency.value = 900;
  bpFilter.Q.value = 1.5;

  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0, now);
  noiseGain.gain.linearRampToValueAtTime(0.35, now + 0.005);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

  noiseSrc.connect(bpFilter);
  bpFilter.connect(noiseGain);
  noiseGain.connect(ctx.destination);
  noiseSrc.start(now);
  noiseSrc.stop(now + 0.25);

  // Layer 2: Willow wood resonance — detuned oscillators
  [265, 282, 298].forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.18 - i * 0.04, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  });
}

function soundBoundaryBell() {
  if (soundsMuted) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;

  [[880, 1.5, 0.22], [1760, 1.2, 0.10], [2640, 0.8, 0.06], [3520, 0.5, 0.03]].forEach(([f, dur, g]) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(g, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.1);
  });
}

function soundCrowdRoar() {
  if (soundsMuted) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const dur = 3.0;

  // Layer 1: Deep stadium rumble — layered filtered noise
  for (let i = 0; i < 3; i++) {
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Pink-ish noise with more low-end
    for (let j = 0; j < d.length; j++) d[j] = (Math.random() * 2 - 1) * (1 - j / d.length * 0.3);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.8 + i * 0.1;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 150 + i * 30;
    const g = ctx.createGain();
    const gainStart = 0.15 + i * 0.05;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gainStart, now + 0.4);
    g.gain.setValueAtTime(gainStart, now + dur - 0.8);
    g.gain.linearRampToValueAtTime(0, now + dur);
    src.connect(lp);
    lp.connect(g);
    g.connect(ctx.destination);
    src.start(now + i * 0.05);
    src.stop(now + dur);
  }

  // Layer 2: Mid-range crowd swell (cheer voices)
  const buf2 = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const d2 = buf2.getChannelData(0);
  for (let i = 0; i < d2.length; i++) {
    // Shaped noise with natural swell envelope
    const t = i / d2.length;
    d2[i] = (Math.random() * 2 - 1) * Math.sin(t * Math.PI) * 0.8;
  }
  const src2 = ctx.createBufferSource();
  src2.buffer = buf2;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 600;
  bp.Q.value = 0.4;
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0, now);
  g2.gain.linearRampToValueAtTime(0.18, now + 0.5);
  g2.gain.setValueAtTime(0.18, now + dur - 1.0);
  g2.gain.linearRampToValueAtTime(0, now + dur);
  src2.connect(bp);
  bp.connect(g2);
  g2.connect(ctx.destination);
  src2.start(now);
  src2.stop(now + dur);

  // Layer 3: High shimmer / whistle hints
  const buf3 = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const d3 = buf3.getChannelData(0);
  for (let i = 0; i < d3.length; i++) {
    d3[i] = (Math.random() * 2 - 1) * 0.4 * (Math.random() > 0.7 ? 1.5 : 0.5);
  }
  const src3 = ctx.createBufferSource();
  src3.buffer = buf3;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3000;
  const g3 = ctx.createGain();
  g3.gain.setValueAtTime(0, now);
  g3.gain.linearRampToValueAtTime(0.05, now + 0.6);
  g3.gain.setValueAtTime(0.05, now + dur - 1.2);
  g3.gain.linearRampToValueAtTime(0, now + dur);
  src3.connect(hp);
  hp.connect(g3);
  g3.connect(ctx.destination);
  src3.start(now);
  src3.stop(now + dur);

  // Layer 4: Ooh-aah chant simulation — detuned oscillators
  [260, 262, 523].forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, now);
    og.gain.linearRampToValueAtTime(0.04, now + 0.6);
    og.gain.setValueAtTime(0.04, now + dur - 0.8);
    og.gain.linearRampToValueAtTime(0, now + dur);
    osc.connect(og);
    og.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  });
}

function soundHowzat() {
  if (soundsMuted) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const dur = 0.65;

  [[180, 0.22], [700, 0.15], [1200, 0.10], [2400, 0.05]].forEach(([f, g]) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(g, now + 0.04);
    gain.gain.setValueAtTime(g, now + 0.2);
    gain.gain.linearRampToValueAtTime(0, now + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  });

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 15;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.3;
  lfo.connect(lfoGain);
  lfoGain.connect(ctx.destination);
  lfo.start(now + 0.05);
  lfo.stop(now + 0.5);
}

function soundStumpsHit() {
  if (soundsMuted) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;

  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.15), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.4, now + 0.003);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  src.connect(hp);
  hp.connect(g);
  g.connect(ctx.destination);
  src.start(now);
  src.stop(now + 0.15);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120, now);
  osc.frequency.exponentialRampToValueAtTime(40, now + 0.15);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0, now);
  og.gain.linearRampToValueAtTime(0.3, now + 0.005);
  og.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  osc.connect(og);
  og.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.18);
}

function soundCrowdGroan() {
  if (soundsMuted) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const dur = 1.8;

  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(400, now);
  bp.frequency.exponentialRampToValueAtTime(150, now + dur);
  bp.Q.value = 1;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.1, now + 0.15);
  g.gain.setValueAtTime(0.1, now + dur * 0.3);
  g.gain.linearRampToValueAtTime(0, now + dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(ctx.destination);
  src.start(now);
  src.stop(now + dur);

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(100, now + dur);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0, now);
  og.gain.linearRampToValueAtTime(0.12, now + 0.1);
  og.gain.exponentialRampToValueAtTime(0.001, now + dur);
  osc.connect(og);
  og.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur);
}

function soundCommentary() {
  if (soundsMuted) return;
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  const dur = 3.5;

  [[180, 182], [215, 218], [260, 263]].forEach(([f1, f2]) => {
    [f1, f2].forEach(f => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.03, now + 0.5);
      g.gain.setValueAtTime(0.03, now + dur - 1);
      g.gain.linearRampToValueAtTime(0, now + dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + dur);
    });
  });
}

function soundRuns(count) {
  soundBatHit();
  if (count === 6 || count === 4) {
    setTimeout(() => soundBoundaryBell(), 50);
    setTimeout(() => soundCrowdRoar(), 80);
  }
}

function soundOut() {
  soundHowzat();
  setTimeout(() => soundStumpsHit(), 100);
  setTimeout(() => soundCrowdGroan(), 200);
}

function soundGameStart() {
  soundCommentary();
  setTimeout(() => {
    sfx({ type: 'sine', freq: 440, freqEnd: 880, duration: 0.5, gain: 0.2, attack: 0.01, release: 0.3 });
    sfx({ type: 'triangle', freq: 660, freqEnd: 1320, duration: 0.4, gain: 0.15, attack: 0.02, release: 0.25 });
  }, 300);
}

function soundInningsBreak() {
  soundCommentary();
  sfx({ type: 'triangle', freq: 660, freqEnd: 440, duration: 0.5, gain: 0.18, attack: 0.01, release: 0.35 });
}

function soundWin() {
  soundCrowdRoar();
  setTimeout(() => soundBoundaryBell(), 100);
  setTimeout(() => {
    [0, 0.18, 0.36].forEach(t => {
      setTimeout(() => sfx({ type: 'square', freq: 523, freqEnd: 1047, duration: 0.22, gain: 0.2, attack: 0.005, release: 0.15 }), t * 1000);
    });
  }, 200);
}

function soundDraw() {
  sfx({ type: 'triangle', freq: 440, freqEnd: 220, duration: 0.6, gain: 0.18, attack: 0.01, release: 0.4 });
}

function soundLose() {
  soundCrowdGroan();
  sfx({ type: 'sawtooth', freq: 330, freqEnd: 110, duration: 0.7, gain: 0.18, attack: 0.01, release: 0.5 });
}

// ── Sound mute toggle (M key) ─────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.code === 'KeyM' && e.target === document.body) {
    soundsMuted = !soundsMuted;
    showToast(soundsMuted ? '🔇 Sounds off' : '🔊 Sounds on');
  }
});

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  home    : $('screen-home'),
  waiting : $('screen-waiting'),
  game    : $('screen-game'),
  break   : $('screen-break'),
  result  : $('screen-result'),
};

// ── Screen management ──────────────────────────────────────────────────────
let currentScreenName = 'home';

function showScreen(name) {
  const current = screens[currentScreenName];
  const next = screens[name];

  // Immediately hide current screen
  if (current && current !== next) {
    current.classList.remove('active');
    current.classList.add('hidden');
  }

  // Show next screen with animation
  next.classList.remove('hidden');
  next.classList.add('active');

  currentScreenName = name;
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, duration = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

// ── WebSocket connection ───────────────────────────────────────────────────
function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen  = onOpen;
  ws.onclose = () => {
    console.log('[DEBUG] ws.onclose', { screen: currentScreen(), gameOver });
    if (currentScreen() === 'result') return;
    if (!['home','result'].includes(currentScreen())) {
      showDisconnect();
    }
  };
  ws.onerror = () => {};
  ws.onmessage = e => {
    try { handleMessage(JSON.parse(e.data)); }
    catch(err) { console.error('[DEBUG] handleMessage threw:', err.message, err.stack); }
  };
}

function currentScreen() {
  for (const [k, el] of Object.entries(screens)) {
    if (!el.classList.contains('hidden')) return k;
  }
  return 'home';
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Message dispatcher ─────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'room_created':         onRoomCreated(msg);       break;
    case 'room_joined':          onRoomJoined(msg);        break;
    case 'opponent_joined':      onOpponentJoined(msg);   break;
    case 'solo_room_created':    onSoloRoomCreated(msg);  break;
    case 'game_start':           onGameStart(msg);         break;
    case 'round_start':          onRoundStart(msg);        break;
    case 'pick_ack':             onPickAck(msg);           break;
    case 'opponent_picked':     onOpponentPicked();      break;
    case 'round_result':         onRoundResult(msg);       break;
    case 'innings_break':        console.log('[DEBUG] innings_break received'); onInningsBreak(msg);      break;
    case 'game_over':            console.log('[DEBUG] game_over received', msg); onGameOver(msg);          break;
    case 'opponent_disconnected': showDisconnect();       break;
    case 'solo_ended':           onSoloEnded();           break;
    case 'error':               showError(msg.message);   break;
  }
}

// ── Home screen ─────────────────────────────────────────────────────────────
$('btn-create').addEventListener('click', () => {
  const name = $('inp-name').value.trim();
  if (!name) { showHomeError('Please enter your name.'); return; }
  hideHomeError();
  myName = name;

  connect(() => {
    wsSend({ type: 'create', name });
  });
});

$('btn-join').addEventListener('click', doJoin);
$('inp-code').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

$('btn-solo').addEventListener('click', () => {
  const name = $('inp-name').value.trim();
  if (!name) { showHomeError('Please enter your name.'); return; }
  hideHomeError();
  myName = name;

  connect(() => {
    wsSend({ type: 'solo', name });
  });
});

function doJoin() {
  const name = $('inp-name').value.trim();
  const code = $('inp-code').value.trim().toUpperCase();
  if (!name) { showHomeError('Please enter your name.'); return; }
  if (code.length < 6) { showHomeError('Enter the 6-character room code.'); return; }
  hideHomeError();
  myName = name;

  connect(() => {
    wsSend({ type: 'join', name, code });
  });
}

function showHomeError(msg) {
  const el = $('home-error');
  el.textContent = msg;
  el.classList.add('show');
}
function hideHomeError() {
  $('home-error').classList.remove('show');
}

// ── Room created (host) ────────────────────────────────────────────────────
function onRoomCreated(msg) {
  playerIndex = msg.playerIndex;
  $('display-code').textContent = msg.code;
  $('btn-copy').style.display = '';
  showScreen('waiting');
}

// ── Solo room created ───────────────────────────────────────────────────────
function onSoloRoomCreated(msg) {
  playerIndex = msg.playerIndex;
  $('display-code').textContent = 'Solo Match';
  $('btn-copy').style.display = 'none';
  gameOver = false;
  // game_start arrives immediately after solo_room_created
}

// ── Room joined (guest) ────────────────────────────────────────────────────
function onRoomJoined(msg) {
  playerIndex = msg.playerIndex;
  playerNames[1 - playerIndex] = msg.opponentName;
  playerNames[playerIndex]     = myName;
  // Game starts immediately after joining — game_start message follows
}

// ── Opponent joined (host sees this) ──────────────────────────────────────
function onOpponentJoined(msg) {
  playerNames[0] = myName;
  playerNames[1] = msg.opponentName;
  showToast(`${msg.opponentName} joined!`);
  // Game starts immediately — game_start message follows
}

// ── Copy code button ───────────────────────────────────────────────────────
$('btn-copy').addEventListener('click', () => {
  const code = $('display-code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = $('btn-copy');
    btn.textContent = '✅ COPIED!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '📋 COPY CODE'; btn.classList.remove('copied'); }, 2000);
  }).catch(() => showToast(`Code: ${code}`));
});

$('btn-cancel-wait').addEventListener('click', () => {
  if (ws) ws.close();
  showScreen('home');
});

// ── Game start ─────────────────────────────────────────────────────────────
function onGameStart(msg) {
  if (!['home', 'game', 'waiting'].includes(currentScreen())) return;

  currentBatter = msg.batter;
  playerNames   = msg.playerNames;
  innings       = 1;
  scores        = [0, 0];
  history       = [[], []];
  myPick        = null;
  pickLocked    = false;
  gameOver      = false;

  // Set bot avatar from server message (solo mode)
  if (msg.botAvatarIdx !== undefined) {
    botAvatarIdx = msg.botAvatarIdx;
  }

  // Set up game screen labels
  $('pname-0').textContent = playerNames[0];
  $('pname-1').textContent = playerNames[1];
  $('pavatar-0').textContent = AVATARS[hashName(playerNames[0]) % AVATARS.length];
  if (botAvatarIdx !== null) {
    $('pavatar-1').textContent = AVATARS[botAvatarIdx];
  } else {
    $('pavatar-1').textContent = AVATARS[(hashName(playerNames[1]) + 3) % AVATARS.length];
  }
  $('flabel-0').textContent = playerIndex === 0 ? 'YOU' : playerNames[0].split(' ')[0];
  $('flabel-1').textContent = playerIndex === 1 ? 'YOU' : playerNames[1].split(' ')[0];

  updateRoleLabels();
  updateScores();
  resetHistoryDots();
  updateBanner();
  $('target-bar').classList.remove('show');

  showScreen('game');
  soundGameStart();
  startAmbientCrowd();

  const myRole = playerIndex === currentBatter ? 'batting' : 'bowling';
  showToast(`You are ${myRole}!`);
}

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return h;
}

// ── Round start ────────────────────────────────────────────────────────────
function onRoundStart(msg) {
  currentBatter = msg.batter;
  innings       = msg.innings;
  scores        = msg.scores;
  history       = msg.history;

  myPick    = null;
  pickLocked = false;

  // If we get round_start while on the break screen, switch to game screen immediately
  if (currentScreen() === 'break') {
    showScreen('game');
  }

  // Show/hide target bar
  if (msg.target) {
    $('target-bar').textContent = `🎯 Need ${msg.target} runs to win`;
    $('target-bar').classList.add('show');
  } else {
    $('target-bar').classList.remove('show');
  }

  updateScores();
  updateRoleLabels();
  renderHistoryDots();
  updateBanner();

  // Reset pick bubbles
  resetPickBubbles();
  // Fists bob animation
  $('fist-0').classList.add('picking');
  $('fist-1').classList.add('picking');

  // Determine if I can pick this round
  const canPick = true; // both can pick (server decides who is batter/bowler)
  enableNumGrid(canPick);
  deselectAllNums();

  setStatus('Pick a number!', '');
  startTimer();
}

// ── Pick ack ───────────────────────────────────────────────────────────────
function onPickAck(msg) {
  myPick = msg.number;
  pickLocked = true;
  disableNumGrid();
  setStatus('Waiting for opponent ⏱️', 'waiting-state');

  // Show bubble for my fist
  const myFistIdx = playerIndex; // fist-0 = player 0, fist-1 = player 1
  showPickBubble(myFistIdx, '?', 'selected');
}

// ── Opponent picked ────────────────────────────────────────────────────────
function onOpponentPicked() {
  const oppIdx = 1 - playerIndex;
  showPickBubble(oppIdx, '?', 'selected');
  // If I already picked too, status stays "Waiting for opponent" or becomes "Revealing..."
  if (pickLocked) {
    setStatus('Revealing… 🔍', 'waiting-state');
  }
}

// ── Round result ───────────────────────────────────────────────────────────
function onRoundResult(msg) {
  stopTimer();
  disableNumGrid();

  scores  = msg.scores;
  history = msg.history;

  // Stop fist bobbing
  $('fist-0').classList.remove('picking');
  $('fist-1').classList.remove('picking');

  const batter     = msg.batter;
  const bowler     = 1 - batter;
  const batterPick = msg.batterPick;
  const bowlerPick = msg.bowlerPick;

  // Handle null picks (timed out — dot ball)
  if (batterPick === null || bowlerPick === null) {
    soundPick();
    setStatus('⏱️ Time out — dot ball!', 'score-state');
    showFlash('0', false);
    updateScores();
    renderHistoryDots();
    setTimeout(() => beginNextRound(), REVEAL_MS);
    return;
  }

  const myPick = playerIndex === batter ? batterPick : bowlerPick;
  const oppPick  = playerIndex === batter ? bowlerPick : batterPick;

  // Highlight my selection
  highlightMyPick(myPick);

  // Reveal pick bubbles — batter first, bowler 0.3s later
  const bubbleClass = msg.isOut ? 'revealed-out' : 'revealed-score';
  showPickBubble(batter, batterPick, bubbleClass);
  setTimeout(() => showPickBubble(bowler, bowlerPick, bubbleClass), 300);

  // Fist reveal animation
  $('fist-0').classList.add('revealed');
  $('fist-1').classList.add('revealed');
  setTimeout(() => {
    $('fist-0').classList.remove('revealed');
    $('fist-1').classList.remove('revealed');
  }, 400);

  if (msg.isOut) {
    soundOut();
    setStatus('💥 WICKET! OUT!', 'out-state');
    showFlash('OUT!', true);
  } else {
    soundRuns(msg.runs);
    const runs = msg.runs;
    const suffix = runs === 6 ? ' 🏏 SIX!' : runs === 4 ? ' 🏃 FOUR!' : ` +${runs}`;
    setStatus(`${playerNames[batter]}${suffix}`, 'score-state');
    showFlash(`+${runs}`, false);
  }

  updateScores();
  renderHistoryDots();
  setTimeout(() => beginNextRound(), REVEAL_MS);
}

// ── Advance to next round after result animation ──────────────────────────
function beginNextRound() {
  if (gameOver) return;

  const ballsPlayed = history[currentBatter].length;
  const atMaxBalls  = ballsPlayed >= 6;
  const amChasing   = innings === 2;
  const target      = amChasing ? scores[1 - currentBatter] + 1 : Infinity;
  const chased      = amChasing && scores[currentBatter] >= target;
  const wicketFell  = history[currentBatter].includes('W');

  if (atMaxBalls || chased || wicketFell) {
    // Innings over (wicket, max balls, or target chased) — server will send innings_break / game_over
    return;
  }

  // Trigger next round locally
  $('fist-0').classList.add('picking');
  $('fist-1').classList.add('picking');
  resetPickBubbles();
  deselectAllNums();
  pickLocked = false;
  enableNumGrid(true);
  updateScores();
  updateRoleLabels();
  renderHistoryDots();
  updateBanner();
  setStatus('Pick a number!', '');
  startTimer();
}

// ── Innings break ──────────────────────────────────────────────────────────
function onInningsBreak(msg) {
  console.log('[DEBUG] onInningsBreak fired', { screen: currentScreen(), gameOver });
  if (currentScreen() === 'result') return;
  stopTimer();
  scores  = msg.scores;
  history = msg.history;

  $('break-name-0').textContent  = msg.playerNames[0];
  $('break-name-1').textContent  = msg.playerNames[1];
  $('break-score-0').textContent = msg.scores[0];
  $('break-score-1').textContent = msg.scores[1];
  $('break-target').textContent  = msg.target;

  soundInningsBreak();
  showScreen('break');
  startAmbientCrowd(); // keep ambient through break
}

// ── Game over ───────────────────────────────────────────────────────────────
function onGameOver(msg) { console.log('[DEBUG] onGameOver fired', { screen: currentScreen(), gameOver });
  stopTimer();
  stopAmbientCrowd();
  gameOver = true;
  // Guard: if we've already handled game over (e.g. innings_break and game_over arrived together), skip
  if (currentScreen() === 'result') return;

  scores  = msg.scores;
  history = msg.history;
  playerNames = msg.playerNames;

  // Trophy / emoji
  let trophy, headline, cls;
  if (msg.isDraw) {
    soundDraw();
    trophy = '🤝'; headline = "It's a Draw!"; cls = 'draw';
  } else if (msg.youWon) {
    soundWin();
    trophy = '🏆'; headline = 'You Won! 🎉'; cls = 'won';
  } else {
    soundLose();
    trophy = '😔'; headline = 'You Lost'; cls = 'lost';
  }

  $('result-trophy').textContent   = trophy;
  $('result-headline').textContent = headline;
  $('result-headline').className   = `result-headline ${cls}`;
  $('result-sub').textContent      = `${msg.playerNames[0]} ${msg.scores[0]}  vs  ${msg.scores[1]} ${msg.playerNames[1]}`;

  // Scoreboard rows
  const board = $('result-scoreboard');
  board.innerHTML = '';

  [0, 1].forEach(i => {
    const isWinner = msg.winner === i;
    const row = document.createElement('div');
    row.className = `result-player-row${isWinner ? ' winner-row' : ''}`;

    const histDots = (msg.history[i] || []).map(v => {
      const cls = v === 'W' ? 'r-out' : 'r-scored';
      const label = v === 'W' ? 'W' : v;
      return `<div class="result-dot ${cls}">${label}</div>`;
    }).join('');

    row.innerHTML = `
      <div>
        <div class="result-pname">${isWinner ? '🥇 ' : ''}${msg.playerNames[i]}</div>
        <div class="result-history">${histDots}</div>
      </div>
      <div class="result-pscore ${isWinner ? 'winner-score' : ''}">${msg.scores[i]}</div>
    `;
    board.appendChild(row);
  });

  console.log('[DEBUG] onGameOver calling showScreen(result), screen was:', document.querySelector('.screen:not(.hidden)')?.id);
  showScreen('result');
}

// ── Play again / home ──────────────────────────────────────────────────────
$('btn-play-again').addEventListener('click', () => {
  // If WS is closed (e.g. after idle), reconnect before sending play_again
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showScreen('waiting');
    connect(() => {
      wsSend({ type: 'play_again' });
    });
    return;
  }
  wsSend({ type: 'play_again' });
  history = [[], []];
  scores  = [0, 0];
  botAvatarIdx = null;
  gameOver = false;
  showScreen('waiting');
});

$('btn-go-home').addEventListener('click', () => {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  botAvatarIdx = null;
  resetToHome();
});

$('btn-exit-game').addEventListener('click', () => {
  if (confirm('Leave the match?')) {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    botAvatarIdx = null;
    resetToHome();
  }
});

$('btn-dc-home').addEventListener('click', () => {
  $('overlay-disconnect').classList.remove('show');
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  botAvatarIdx = null;
  resetToHome();
});

function onSoloEnded() {
  stopTimer();
  $('result-trophy').textContent = '😔';
  $('result-headline').textContent = 'Match Ended';
  $('result-headline').className = 'result-headline lost';
  $('result-sub').textContent = 'You left the solo match.';
  const board = $('result-scoreboard');
  board.innerHTML = '<p style="color:var(--muted);font-size:13px;text-align:center;">No result recorded.</p>';
  showScreen('result');
}

function resetToHome() {
  playerIndex = null;
  myName = '';
  playerNames = ['', ''];
  botAvatarIdx = null;
  stopTimer();
  $('overlay-disconnect').classList.remove('show');
  $('home-error').classList.remove('show');
  showScreen('home');
}

// ── Number grid ────────────────────────────────────────────────────────────
document.querySelectorAll('.num-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (pickLocked || btn.disabled) return;
    soundPick();
    const num = parseInt(btn.dataset.num, 10);
    wsSend({ type: 'pick', number: num });
    deselectAllNums();
    btn.classList.add('selected');
    // Optimistic lock — server will confirm with pick_ack
  });
});

function enableNumGrid(enabled) {
  document.querySelectorAll('.num-btn').forEach(b => b.disabled = !enabled);
}
function disableNumGrid() { enableNumGrid(false); }

function deselectAllNums() {
  document.querySelectorAll('.num-btn').forEach(b => b.classList.remove('selected'));
}

function highlightMyPick(num) {
  document.querySelectorAll('.num-btn').forEach(b => {
    b.classList.toggle('selected', parseInt(b.dataset.num) === num);
  });
}

// ── Timer ──────────────────────────────────────────────────────────────────
function startTimer() {
  stopTimer();
  timerLeft = TIMER_TOTAL;
  renderTimer(timerLeft);

  timerID = setInterval(() => {
    timerLeft--;
    renderTimer(timerLeft);
    if (timerLeft <= 0) {
      stopTimer();
    }
  }, 1000);
}

function stopTimer() {
  if (timerID) { clearInterval(timerID); timerID = null; }
}

function renderTimer(seconds) {
  const s = Math.max(0, seconds);
  $('timer-num').textContent = s;
  const offset = CIRCUMFERENCE * (1 - s / TIMER_TOTAL);
  $('timer-progress').style.strokeDashoffset = offset;
  $('timer-progress').classList.toggle('urgent', s <= 2);
}

// ── Status bar ─────────────────────────────────────────────────────────────
function setStatus(text, cls = '') {
  const el = $('status-bar');
  el.textContent = text;
  el.className = `status-bar ${cls}`.trim();
}

// ── Scoreboard update ──────────────────────────────────────────────────────
function updateScores() {
  $('pscore-0').textContent = scores[0];
  $('pscore-1').textContent = scores[1];
}

function updateRoleLabels() {
  const batter = currentBatter;
  const bowler = 1 - batter;

  [0, 1].forEach(i => {
    const el   = $(`prole-${i}`);
    const isBat = i === batter;
    el.textContent = isBat ? '🏏 Batting' : '⚾ Bowling';
    el.className   = `card-role ${isBat ? 'batting' : 'bowling'}`;
  });
}

function updateBanner() {
  if (currentBatter !== null) {
    $('team-banner').textContent = `GO ${playerNames[currentBatter].toUpperCase()}!`;
  }
}

// ── Ball history dots ──────────────────────────────────────────────────────
function resetHistoryDots() {
  [0, 1].forEach(p => {
    const row = $(`phistory-${p}`);
    row.querySelectorAll('.ball-dot').forEach(d => {
      d.className = 'ball-dot';
      d.textContent = '';
    });
  });
}

function renderHistoryDots() {
  [0, 1].forEach(p => {
    const row  = $(`phistory-${p}`);
    const dots = row.querySelectorAll('.ball-dot');
    const hist = history[p] || [];

    dots.forEach((dot, i) => {
      if (i < hist.length) {
        const val = hist[i];
        dot.textContent = val === 'W' ? 'W' : val;
        dot.className   = `ball-dot ${val === 'W' ? 'out' : 'scored'}${i === hist.length - 1 ? ' latest' : ''}`;
      } else {
        dot.textContent = '';
        dot.className   = 'ball-dot';
      }
    });
  });
}

// ── Pick bubbles ───────────────────────────────────────────────────────────
function resetPickBubbles() {
  [0, 1].forEach(i => {
    const b = $(`pbubble-${i}`);
    b.textContent = '';
    b.className   = 'pick-bubble';
  });
}

function showPickBubble(playerIdx, text, cls) {
  const b = $(`pbubble-${playerIdx}`);
  b.textContent = text;
  b.className   = `pick-bubble ${cls}`;
}

// ── Flash overlay ──────────────────────────────────────────────────────────
function showFlash(text, isOut) {
  const overlay = $('result-flash');
  const badge   = $('flash-badge');

  badge.textContent = text;
  badge.className   = `flash-badge${isOut ? ' out-badge' : ''}`;
  overlay.className = `result-flash show ${isOut ? 'flash-out' : 'flash-runs'}`;

  setTimeout(() => { overlay.className = 'result-flash'; }, 900);
}

// ── Disconnect ─────────────────────────────────────────────────────────────
function showDisconnect() {
  stopTimer();
  $('overlay-disconnect').classList.add('show');
}

// ── Error ──────────────────────────────────────────────────────────────────
function showError(msg) {
  showHomeError(msg);
  showScreen('home');
}

// ── Init ───────────────────────────────────────────────────────────────────
(function init() {
  showScreen('home');
  $('screen-home').classList.add('active');
  renderTimer(TIMER_TOTAL);
  enableNumGrid(false);

  // Register service worker for PWA / offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
