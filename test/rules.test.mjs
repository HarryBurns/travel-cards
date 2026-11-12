// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, CARD_BY_ID } from '../js/cards.js';
import {
  canPlay, createGame, buildDeck, SEEN_SHARE, applyPlay, applyDraw, applyLeave, applyAuto, playable, normalize, topCard, HAND_SIZE,
} from '../js/rules.js';

function rngFrom(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

const first = (type, fx) => CARDS.find((c) => c.type === type && c.fx === fx).id;
const SIGHT2 = CARDS.filter((c) => c.type === 'sight' && !c.fx)[1].id;
const SIGHT = first('sight'), FOOD = first('food'), DRINK = first('drink'), TOILET = first('toilet'), JOKER = first('joker');

function totalCards(s) {
  return s.deck.length + s.pile.length + Object.values(s.hands).reduce((n, h) => n + h.length, 0);
}

// Собирает состояние с заданными руками и верхней картой
function setup(hands, top, extra = {}) {
  const order = Object.keys(hands);
  const used = new Set([top, ...Object.values(hands).flat()]);
  return {
    status: 'playing', order, names: Object.fromEntries(order.map((id) => [id, id])),
    hands: structuredClone(hands), deck: CARDS.map((c) => c.id).filter((id) => !used.has(id)),
    pile: [top], dir: 1, turn: order[0], winner: null, seq: 0, log: [], ...extra,
  };
}

test('колода: уникальные id, все типы на месте', () => {
  assert.equal(new Set(CARDS.map((c) => c.id)).size, CARDS.length);
  for (const c of CARDS) {
    assert.match(c.id, /^[a-z0-9_]+$/);
    assert.ok(c.name && c.text, c.id);
  }
  const count = (t) => CARDS.filter((c) => c.type === t).length;
  assert.ok(count('sight') >= 30 && count('toilet') >= 30 && count('joker') >= 15);
  assert.ok(count('food') + count('drink') >= 30);
});

test('цикл: что на что можно класть', () => {
  assert.ok(canPlay(FOOD, SIGHT));
  assert.ok(canPlay(DRINK, SIGHT));
  assert.ok(!canPlay(TOILET, SIGHT));
  assert.ok(!canPlay(SIGHT, SIGHT));
  assert.ok(canPlay(DRINK, FOOD));
  assert.ok(canPlay(TOILET, FOOD));
  assert.ok(!canPlay(SIGHT, FOOD));
  assert.ok(!canPlay(FOOD, FOOD));
  assert.ok(canPlay(TOILET, DRINK));
  assert.ok(!canPlay(FOOD, DRINK));
  assert.ok(!canPlay(SIGHT, DRINK));
  assert.ok(canPlay(SIGHT, TOILET));
  assert.ok(!canPlay(FOOD, TOILET));
  for (const c of [SIGHT, FOOD, DRINK, TOILET, JOKER]) {
    assert.ok(canPlay(JOKER, c));
    assert.ok(canPlay(c, JOKER));
  }
});

test('раздача: по 6 карт, у первого игрока 5, одна на столе', () => {
  for (let n = 2; n <= 6; n++) {
    const ids = Array.from({ length: n }, (_, i) => 'p' + i);
    const s = createGame(ids, {}, rngFrom(n * 7));
    assert.equal(totalCards(s), CARDS.length);
    assert.equal(s.pile.length, 1);
    const starter = s.last.by;
    for (const id of ids) assert.equal(s.hands[id].length, id === starter ? HAND_SIZE - 1 : HAND_SIZE);
    assert.notEqual(s.turn, starter);
  }
});

test('колода новой партии: недавно виденные карты уходят на дно', () => {
  const all = CARDS.map((c) => c.id);
  const seen = all.slice(0, 40);
  const deck = buildDeck(seen, rngFrom(11));
  assert.equal(deck.length, all.length);
  assert.equal(new Set(deck).size, all.length);
  const top = deck.slice(-(all.length - 40));
  assert.ok(top.every((id) => !seen.includes(id)), 'сверху только свежие карты');
  // из виденных раньше приходят те, что попадались давнее
  const firstOld = deck.slice(20, 40), lastOld = deck.slice(0, 20);
  assert.ok(firstOld.every((id) => seen.indexOf(id) < 20));
  assert.ok(lastOld.every((id) => seen.indexOf(id) >= 20));
  // память ограничена: даже если видели всё, свежая часть остаётся
  const full = buildDeck(all.concat(['нет_такой', all[3]]), rngFrom(12));
  assert.equal(new Set(full).size, all.length);
  const stale = Math.floor(all.length * SEEN_SHARE);
  assert.ok(full.slice(0, stale).every((id) => all.indexOf(id) >= all.length - stale || id === all[3]));
  // раздача идёт из свежих
  const s = createGame(['a', 'b', 'c'], {}, rngFrom(13), seen);
  for (const id of [...s.hands.a, ...s.hands.b, ...s.hands.c, ...s.pile]) assert.ok(!seen.includes(id));
});

test('обычный ход передаёт очередь, чужой ход и неподходящая карта отклоняются', () => {
  const s = setup({ a: [FOOD, SIGHT], b: [TOILET, DRINK], c: [JOKER] }, SIGHT2);
  assert.equal(applyPlay(s, 'b', DRINK), null);
  assert.equal(applyPlay(s, 'a', SIGHT), null);
  const s2 = applyPlay(s, 'a', FOOD);
  assert.equal(s2.turn, 'b');
  assert.equal(topCard(s2), FOOD);
  assert.deepEqual(s2.hands.a, [SIGHT]);
  assert.equal(s.hands.a.length, 2, 'исходное состояние не меняется');
});

test('победа: последняя карта завершает игру, эффект не применяется', () => {
  const swap = first('joker', 'swap');
  const s = setup({ a: [swap], b: [TOILET, DRINK] }, SIGHT);
  const s2 = applyPlay(s, 'a', swap);
  assert.equal(s2.status, 'finished');
  assert.equal(s2.winner, 'a');
  assert.equal(s2.hands.b.length, 2);
});

test('пропуск хода', () => {
  const skip = first('sight', 'skip');
  const s = setup({ a: [skip, FOOD], b: [FOOD], c: [FOOD] }, TOILET);
  const s2 = applyPlay(s, 'a', skip);
  assert.equal(s2.turn, 'c');
  assert.equal(s2.last.victim, 'b');
  const two = setup({ a: [skip, FOOD], b: [FOOD] }, TOILET);
  assert.equal(applyPlay(two, 'a', skip).turn, 'a');
});

test('разворот', () => {
  const rev = first('sight', 'reverse');
  const s = setup({ a: [rev, FOOD], b: [FOOD], c: [FOOD] }, TOILET);
  const s2 = applyPlay(s, 'a', rev);
  assert.equal(s2.dir, -1);
  assert.equal(s2.turn, 'c');
  const two = setup({ a: [rev, FOOD], b: [FOOD] }, TOILET);
  assert.equal(applyPlay(two, 'a', rev).turn, 'a');
});

test('плюс две: следующий берёт 2 и пропускает', () => {
  const d2 = first('food', 'draw2');
  const s = setup({ a: [d2, FOOD], b: [DRINK], c: [TOILET] }, SIGHT);
  const s2 = applyPlay(s, 'a', d2);
  assert.equal(s2.hands.b.length, 3);
  assert.equal(s2.turn, 'c');
  assert.equal(totalCards(s2), CARDS.length);
});

test('ещё ход', () => {
  const again = first('drink', 'again');
  const s = setup({ a: [again, TOILET], b: [FOOD] }, SIGHT);
  assert.equal(applyPlay(s, 'a', again).turn, 'a');
});

test('обмен руками требует цель', () => {
  const swap = first('joker', 'swap');
  const s = setup({ a: [swap, FOOD, DRINK], b: [TOILET], c: [SIGHT] }, SIGHT2);
  assert.equal(applyPlay(s, 'a', swap), null);
  assert.equal(applyPlay(s, 'a', swap, { target: 'a' }), null);
  const s2 = applyPlay(s, 'a', swap, { target: 'c' });
  assert.deepEqual(s2.hands.a, [SIGHT]);
  assert.deepEqual(s2.hands.c, [FOOD, DRINK]);
  assert.equal(s2.turn, 'b');
});

test('добор: только когда нечем ходить; тянем до подходящей', () => {
  const s = setup({ a: [SIGHT], b: [FOOD] }, SIGHT2);
  const s2 = applyDraw(s, 'a', rngFrom(3));
  assert.equal(s2.turn, 'a');
  assert.ok(s2.last.cnt >= 1);
  assert.equal(s2.hands.a.length, 1 + s2.last.cnt);
  assert.equal(playable(s2, 'a').length, 1);
  assert.equal(playable(s2, 'a')[0], s2.hands.a.at(-1));
  assert.equal(applyDraw(s2, 'a'), null, 'есть чем ходить — брать нельзя');
  assert.equal(applyDraw(s, 'b'), null, 'не свой ход');
});

test('добор: сброс замешивается, когда колода кончилась', () => {
  const s = setup({ a: [SIGHT], b: [FOOD] }, SIGHT2);
  s.pile = s.deck.concat(s.pile);
  s.deck = [];
  const before = totalCards(s);
  const s2 = applyDraw(s, 'a', rngFrom(5));
  assert.equal(totalCards(s2), before);
  assert.equal(s2.pile.length, 1);
  assert.equal(playable(s2, 'a').length, 1);
});

test('добор: если брать нечего — ход переходит дальше', () => {
  const s = setup({ a: [SIGHT], b: [FOOD] }, SIGHT2);
  s.deck = [];
  const s2 = applyDraw(s, 'a');
  assert.equal(s2.last.t, 'pass');
  assert.equal(s2.turn, 'b');
});

test('выход из игры', () => {
  const s = setup({ a: [SIGHT], b: [FOOD], c: [DRINK] }, SIGHT2);
  const s2 = applyLeave(s, 'a');
  assert.deepEqual(s2.order, ['b', 'c']);
  assert.equal(s2.turn, 'b');
  assert.equal(totalCards(s2), CARDS.length);
  const s3 = applyLeave(s2, 'c');
  assert.equal(s3.status, 'finished');
  assert.equal(s3.winner, 'b');
  assert.equal(s3.reason, 'left');
});

test('normalize восстанавливает пустые массивы после Firebase', () => {
  const s = setup({ a: [SIGHT], b: [FOOD] }, SIGHT2);
  const raw = JSON.parse(JSON.stringify(s));
  delete raw.deck; delete raw.log; delete raw.hands.b;
  raw.pile = { 0: SIGHT2 };
  const n = normalize(raw);
  assert.deepEqual(n.deck, []);
  assert.deepEqual(n.hands.b, []);
  assert.deepEqual(n.pile, [SIGHT2]);
  assert.equal(normalize(null), null);
});

test('автоигра: партии любого размера всегда заканчиваются, карты не теряются', () => {
  const lengths = [];
  for (let seed = 1; seed <= 300; seed++) {
    const rng = rngFrom(seed * 2654435761);
    const n = 2 + (seed % 5);
    let s = createGame(Array.from({ length: n }, (_, i) => 'p' + i), {}, rng);
    let moves = 0;
    while (s.status === 'playing') {
      const next = applyAuto(s, rng);
      assert.ok(next, 'автоход всегда возможен');
      s = normalize(JSON.parse(JSON.stringify(next)));
      assert.equal(totalCards(s), CARDS.length);
      assert.equal(new Set([...s.deck, ...s.pile, ...Object.values(s.hands).flat()]).size, CARDS.length, 'ни одна карта не задвоилась');
      for (const id of s.pile) assert.ok(CARD_BY_ID[id]);
      assert.ok(++moves < 5000, 'партия не зациклилась');
    }
    assert.ok(s.winner);
    assert.equal(s.hands[s.winner].length, 0);
    lengths.push(moves);
  }
  lengths.sort((a, b) => a - b);
  console.log('ходов за партию: мин', lengths[0], 'медиана', lengths[150], 'макс', lengths.at(-1));
});
