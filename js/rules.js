// Чистая логика игры: никаких DOM и сети. Все функции возвращают новое состояние
// (или null, если ход недопустим), поэтому их можно безопасно гонять в транзакциях.
import { CARDS, CARD_BY_ID } from './cards.js';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const HAND_SIZE = 4;
const LOG_LIMIT = 30;

// Что можно положить на карту данного типа
export const NEXT = {
  sight: ['food', 'drink'],
  food: ['drink', 'toilet'],
  drink: ['toilet'],
  toilet: ['sight'],
  joker: ['sight', 'food', 'drink', 'toilet'],
};

export function canPlay(cardId, topId) {
  const card = CARD_BY_ID[cardId];
  const top = CARD_BY_ID[topId];
  if (!card) return false;
  if (!top) return true;
  if (card.type === 'joker' || top.type === 'joker') return true;
  return NEXT[top.type].includes(card.type);
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Firebase не хранит пустые массивы и объекты — восстанавливаем их.
export function normalize(raw) {
  if (!raw || !raw.order) return null;
  const s = { ...raw };
  s.order = toArr(raw.order);
  s.deck = toArr(raw.deck);
  s.pile = toArr(raw.pile);
  s.log = toArr(raw.log);
  s.names = raw.names || {};
  s.hands = {};
  for (const id of Object.keys(s.names)) s.hands[id] = toArr(raw.hands && raw.hands[id]);
  s.dir = raw.dir === -1 ? -1 : 1;
  s.seq = raw.seq || 0;
  s.winner = raw.winner || null;
  return s;
}

function toArr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null);
  return Object.keys(v).sort((a, b) => a - b).map((k) => v[k]);
}

const clone = (s) => JSON.parse(JSON.stringify(s));

export function topCard(s) {
  return s.pile[s.pile.length - 1];
}

export function playable(s, uid) {
  const top = topCard(s);
  return (s.hands[uid] || []).filter((c) => canPlay(c, top));
}

function stepFrom(s, uid, steps = 1) {
  const n = s.order.length;
  const i = s.order.indexOf(uid);
  return s.order[(((i + s.dir * steps) % n) + n) % n];
}

function pushLog(s, ev) {
  s.seq += 1;
  ev.n = s.seq;
  s.last = ev;
  s.log.push(ev);
  if (s.log.length > LOG_LIMIT) s.log = s.log.slice(-LOG_LIMIT);
}

// Берёт одну карту из колоды, при необходимости замешивая сброс. null — брать нечего.
function drawOne(s, rng) {
  if (!s.deck.length) {
    if (s.pile.length <= 1) return null;
    const top = s.pile.pop();
    s.deck = shuffle(s.pile, rng);
    s.pile = [top];
  }
  return s.deck.pop();
}

// Доля колоды, которую помним как «недавно виденную»
export const SEEN_SHARE = 0.65;

// Колода для новой партии. Карты берутся с конца массива, поэтому наверх кладём те,
// что давно не попадались, а недавно виденные (seen: от старых к новым) уходят на дно.
export function buildDeck(seen = [], rng = Math.random) {
  const all = CARDS.map((c) => c.id);
  const known = new Set(all);
  const limit = Math.floor(all.length * SEEN_SHARE);
  const old = [...new Set(seen.filter((id) => known.has(id)).reverse())].reverse().slice(-limit);
  const oldSet = new Set(old);
  const fresh = shuffle(all.filter((id) => !oldSet.has(id)), rng);
  const half = Math.ceil(old.length / 2);
  const older = shuffle(old.slice(0, half), rng);
  const newer = shuffle(old.slice(half), rng);
  return [...newer, ...older, ...fresh];
}

export function createGame(playerIds, names, rng = Math.random, seen = []) {
  const order = shuffle(playerIds, rng);
  const s = {
    status: 'playing',
    order,
    names: Object.fromEntries(order.map((id) => [id, names[id] || 'Турист'])),
    hands: {},
    deck: buildDeck(seen, rng),
    pile: [],
    dir: 1,
    turn: null,
    winner: null,
    seq: 0,
    log: [],
  };
  for (const id of order) s.hands[id] = s.deck.splice(-HAND_SIZE);
  // Случайный игрок ходит первым: его случайная карта ложится на стол (без эффектов).
  const first = order[Math.floor(rng() * order.length)];
  const hand = s.hands[first];
  const card = hand.splice(Math.floor(rng() * hand.length), 1)[0];
  s.pile.push(card);
  s.turn = stepFrom(s, first);
  pushLog(s, { t: 'start', by: first, card });
  return s;
}

function finish(s, winner, reason) {
  s.status = 'finished';
  s.winner = winner;
  s.reason = reason;
  s.turn = null;
}

// Ход картой. opts.target — с кем меняться для эффекта swap.
export function applyPlay(state, uid, cardId, opts = {}, rng = Math.random) {
  if (!state || state.status !== 'playing' || state.turn !== uid) return null;
  const hand = state.hands[uid] || [];
  if (!hand.includes(cardId) || !canPlay(cardId, topCard(state))) return null;
  const card = CARD_BY_ID[cardId];
  if (card.fx === 'swap' && hand.length > 1) {
    if (!opts.target || opts.target === uid || !state.order.includes(opts.target)) return null;
  }
  const s = clone(state);
  s.hands[uid] = s.hands[uid].filter((c) => c !== cardId);
  s.pile.push(cardId);
  const ev = { t: 'play', by: uid, card: cardId };

  if (!s.hands[uid].length) {
    finish(s, uid, 'win');
    pushLog(s, ev);
    return s;
  }

  const two = s.order.length === 2;
  switch (card.fx) {
    case 'skip': {
      ev.fx = 'skip';
      ev.victim = stepFrom(s, uid);
      s.turn = stepFrom(s, uid, 2);
      break;
    }
    case 'reverse': {
      ev.fx = 'reverse';
      s.dir = -s.dir;
      // Вдвоём разворот работает как пропуск хода соперника
      s.turn = two ? uid : stepFrom(s, uid);
      break;
    }
    case 'draw2': {
      ev.fx = 'draw2';
      const victim = stepFrom(s, uid);
      ev.victim = victim;
      let got = 0;
      for (let i = 0; i < 2; i++) {
        const c = drawOne(s, rng);
        if (!c) break;
        s.hands[victim].push(c);
        got++;
      }
      ev.cnt = got;
      s.turn = stepFrom(s, uid, 2);
      break;
    }
    case 'again': {
      ev.fx = 'again';
      s.turn = uid;
      break;
    }
    case 'swap': {
      ev.fx = 'swap';
      ev.victim = opts.target;
      const mine = s.hands[uid];
      s.hands[uid] = s.hands[opts.target];
      s.hands[opts.target] = mine;
      s.turn = stepFrom(s, uid);
      break;
    }
    default:
      s.turn = stepFrom(s, uid);
  }
  pushLog(s, ev);
  return s;
}

// Добор: только когда ходить нечем. Тянем, пока не придёт подходящая карта.
export function applyDraw(state, uid, rng = Math.random) {
  if (!state || state.status !== 'playing' || state.turn !== uid) return null;
  if (playable(state, uid).length) return null;
  const s = clone(state);
  const top = topCard(s);
  let cnt = 0;
  let found = false;
  while (!found) {
    const c = drawOne(s, rng);
    if (!c) break;
    s.hands[uid].push(c);
    cnt++;
    found = canPlay(c, top);
  }
  if (found) {
    pushLog(s, { t: 'draw', by: uid, cnt });
  } else {
    // Колода и сброс пусты (все карты на руках) — ход переходит дальше
    s.turn = stepFrom(s, uid);
    pushLog(s, { t: 'pass', by: uid, cnt });
  }
  return s;
}

// Игрок вышел из партии: его карты возвращаются в колоду.
export function applyLeave(state, uid, rng = Math.random) {
  if (!state || state.status !== 'playing' || !state.order.includes(uid)) return null;
  const s = clone(state);
  const next = stepFrom(s, uid);
  s.deck = shuffle(s.deck.concat(s.hands[uid] || []), rng);
  s.hands[uid] = [];
  s.order = s.order.filter((id) => id !== uid);
  if (s.turn === uid) s.turn = next;
  if (s.order.length < 2) finish(s, s.order[0] || null, 'left');
  pushLog(s, { t: 'leave', by: uid });
  return s;
}

// Автоход за отвалившегося игрока (того, чей сейчас ход).
export function applyAuto(state, rng = Math.random) {
  if (!state || state.status !== 'playing') return null;
  const uid = state.turn;
  const options = playable(state, uid);
  if (!options.length) {
    const s = applyDraw(state, uid, rng);
    if (s) s.last.auto = true;
    return s;
  }
  const cardId = options[Math.floor(rng() * options.length)];
  let target;
  if (CARD_BY_ID[cardId].fx === 'swap') {
    // меняемся с тем, у кого меньше всего карт
    target = state.order
      .filter((id) => id !== uid)
      .sort((a, b) => state.hands[a].length - state.hands[b].length)[0];
  }
  const s = applyPlay(state, uid, cardId, { target }, rng);
  if (s) s.last.auto = true;
  return s;
}
