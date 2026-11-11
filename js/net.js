// Вся работа с Firebase Realtime Database.
//
// Структура базы (внутри корня v1):
//   lobby/{uid}            {name, room}                – кто сейчас онлайн
//   rooms/{id}             {name, host, status, createdAt, updatedAt, players/{uid}: {name, joinedAt}}
//   games/{id}/state       состояние партии (см. rules.js)
//   games/{id}/presence/{uid}  {on, at}                – кто из игроков на связи
//   games/{id}/reactions/{uid} {i, at}                 – последняя фраза игрока
import {
  initializeApp, getDatabase, ref, onValue, set, update, remove, push, runTransaction, onDisconnect, serverTimestamp,
} from './vendor/firebase.js';
import { DATABASE_URL } from './config.js';
import {
  normalize, createGame, applyPlay, applyDraw, applyLeave, applyAuto, MIN_PLAYERS, MAX_PLAYERS,
} from './rules.js';

const params = new URLSearchParams(location.search);
// ?ns=что-нибудь – отдельная «песочница» в базе для тестов
const NS = params.get('ns') ? 'test/' + params.get('ns').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) : 'v1';

const db = getDatabase(initializeApp({ databaseURL: DATABASE_URL }));
const at = (path) => ref(db, `${NS}/${path}`);

function makeUid() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

function stored(key, make) {
  try {
    let v = localStorage.getItem(key);
    if (!v && make) {
      v = make();
      localStorage.setItem(key, v);
    }
    return v;
  } catch {
    return make ? make() : null;
  }
}

export const uid = stored('tc_uid', makeUid);

// ── время и соединение ──
let offset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (s) => { offset = s.val() || 0; });
export const now = () => Date.now() + offset;

export function onConnected(cb) {
  return onValue(ref(db, '.info/connected'), (s) => cb(!!s.val()));
}

// ── подписки ──
export const watchLobby = (cb) => onValue(at('lobby'), (s) => cb(s.val() || {}));
export const watchRooms = (cb) => onValue(at('rooms'), (s) => cb(s.val() || {}));
export const watchRoom = (id, cb) => onValue(at(`rooms/${id}`), (s) => cb(s.val()));
export function watchGame(id, cb) {
  return onValue(at(`games/${id}`), (s) => {
    const v = s.val() || {};
    cb({ state: normalize(v.state), presence: v.presence || {}, reactions: v.reactions || {} });
  });
}

// ── присутствие ──
// Вызывается при каждом (пере)подключении и смене экрана: обработчики onDisconnect одноразовые.
export function arm({ name, roomId, status, inRoom }) {
  const me = at(`lobby/${uid}`);
  onDisconnect(me).remove();
  set(me, { name, room: roomId || null });
  if (!roomId) return;
  const seat = at(`rooms/${roomId}/players/${uid}`);
  const presence = at(`games/${roomId}/presence/${uid}`);
  if (status === 'waiting') {
    // Из ещё не начатой игры отвалившийся игрок просто исчезает
    if (inRoom) onDisconnect(seat).remove();
  } else if (status === 'playing') {
    onDisconnect(seat).cancel();
    onDisconnect(presence).set({ on: false, at: serverTimestamp() });
    set(presence, { on: true, at: serverTimestamp() });
  } else {
    onDisconnect(seat).cancel();
  }
}

export function leaveLobby() {
  return remove(at(`lobby/${uid}`));
}

// ── комнаты ──
export async function createRoom(name) {
  const node = push(at('rooms'));
  await set(node, {
    name: `Игра ${name}`,
    host: uid,
    status: 'waiting',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    players: { [uid]: { name, joinedAt: serverTimestamp() } },
  });
  return node.key;
}

// true – мы в комнате; false – мест нет, игра уже идёт или комнаты больше нет
export async function joinRoom(id, name) {
  const res = await runTransaction(at(`rooms/${id}`), (room) => {
    if (!room) return room;
    if (room.status !== 'waiting') return undefined;
    const players = room.players || {};
    if (players[uid]) return undefined;
    if (Object.keys(players).length >= MAX_PLAYERS) return undefined;
    room.players = { ...players, [uid]: { name, joinedAt: serverTimestamp() } };
    room.updatedAt = serverTimestamp();
    return room;
  });
  const room = res.snapshot.val();
  return !!(room && room.status === 'waiting' && room.players && room.players[uid]);
}

export async function leaveRoom(id) {
  await onDisconnect(at(`rooms/${id}/players/${uid}`)).cancel();
  await remove(at(`rooms/${id}/players/${uid}`));
  // Пустую комнату убираем сразу
  await runTransaction(at(`rooms/${id}`), (room) => {
    if (!room) return room;
    if (room.status === 'waiting' && !room.players) return null;
    return undefined;
  });
}

export function hostOf(room) {
  const players = room.players || {};
  if (players[room.host]) return room.host;
  const ids = Object.keys(players).sort((a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0));
  return ids[0] || null;
}

export async function startGame(id) {
  const res = await runTransaction(at(`rooms/${id}`), (room) => {
    if (!room) return room;
    if (room.status !== 'waiting' || hostOf(room) !== uid) return undefined;
    if (Object.keys(room.players || {}).length < MIN_PLAYERS) return undefined;
    room.status = 'playing';
    room.round = (room.round || 0) + 1;
    room.updatedAt = serverTimestamp();
    return room;
  });
  const room = res.snapshot.val();
  if (!res.committed || !room) return false;
  const names = Object.fromEntries(Object.entries(room.players).map(([k, p]) => [k, p.name]));
  const state = createGame(Object.keys(names), names);
  state.round = room.round; // чтобы клиенты не приняли прошлую партию за новую
  state.at = serverTimestamp();
  state.t0 = serverTimestamp();
  // presence не трогаем: игроки могли отметиться раньше, чем дошла раздача
  await update(at(`games/${id}`), { state, reactions: null });
  return true;
}

// После партии: комната снова ждёт игроков. Все, кто остался на экране итогов, вернутся в неё сами.
export async function rematch(id) {
  const res = await runTransaction(at(`rooms/${id}`), (room) => {
    if (!room) return room;
    if (room.status !== 'finished') return undefined;
    room.status = 'waiting';
    room.host = uid;
    room.players = null;
    room.updatedAt = serverTimestamp();
    return room;
  });
  return res.committed;
}

// ── ходы ──
async function move(id, fn) {
  const res = await runTransaction(at(`games/${id}/state`), (raw) => {
    if (!raw) return raw;
    const next = fn(normalize(raw));
    if (!next) return undefined;
    next.at = serverTimestamp();
    return next;
  });
  if (!res.committed) return null;
  const state = normalize(res.snapshot.val());
  if (state) {
    update(at(`rooms/${id}`), {
      updatedAt: serverTimestamp(),
      ...(state.status === 'finished' ? { status: 'finished' } : {}),
    }).catch(() => {});
  }
  return state;
}

export const play = (id, cardId, target) => move(id, (s) => applyPlay(s, uid, cardId, { target }));
export const draw = (id) => move(id, (s) => applyDraw(s, uid));
export const autoMove = (id, seq) => move(id, (s) => (s.seq === seq ? applyAuto(s) : null));

export async function leaveGame(id) {
  await move(id, (s) => applyLeave(s, uid));
  await remove(at(`rooms/${id}/players/${uid}`)).catch(() => {});
  await onDisconnect(at(`games/${id}/presence/${uid}`)).cancel().catch(() => {});
  await remove(at(`games/${id}/presence/${uid}`)).catch(() => {});
}

export function markFinished(id) {
  return update(at(`rooms/${id}`), { status: 'finished', updatedAt: serverTimestamp() }).catch(() => {});
}

export function react(id, i) {
  return set(at(`games/${id}/reactions/${uid}`), { i, at: serverTimestamp() });
}

// ── уборка: сервера нет, поэтому заброшенные комнаты убирают сами игроки из лобби ──
const MIN = 60_000;
export function cleanup(rooms) {
  const t = now();
  for (const [id, room] of Object.entries(rooms)) {
    const age = t - (room.updatedAt || room.createdAt || 0);
    const empty = !room.players || !Object.keys(room.players).length;
    const dead =
      (room.status === 'waiting' && empty && age > 0.5 * MIN) ||
      (room.status === 'playing' && age > 30 * MIN) ||
      (room.status === 'finished' && age > 10 * MIN) ||
      (!room.status && age > MIN);
    if (dead) {
      remove(at(`rooms/${id}`)).catch(() => {});
      remove(at(`games/${id}`)).catch(() => {});
    }
  }
}
