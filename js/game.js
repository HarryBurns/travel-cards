// Игровой стол
import { html, useState, useEffect, useRef, useMemo, useLayoutEffect } from './vendor/preact.js';
import * as net from './net.js';
import { CARD_BY_ID, TYPES, PHRASES, EMOJIS } from './cards.js';
import { NEXT, canPlay, topCard } from './rules.js';
import { RECONNECT_GRACE_MS, AUTO_MOVE_DELAY_MS } from './config.js';
import { remember } from './seen.js';
import { Card, CardBack, Modal, Rules, avatar, cardsWord, cardsLeft } from './ui.js';

const TYPE_ORDER = { sight: 0, food: 1, drink: 2, toilet: 3, joker: 4 };
const NOTICE_MS = 5000;

function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    const ca = CARD_BY_ID[a], cb = CARD_BY_ID[b];
    return TYPE_ORDER[ca.type] - TYPE_ORDER[cb.type] || ca.name.localeCompare(cb.name, 'ru');
  });
}

// Текст события для строки статуса
function describe(ev, names) {
  if (!ev) return '';
  const N = (id) => names[id] || 'Турист';
  const bot = ev.auto ? '🤖 ' : '';
  const card = ev.card ? `«${CARD_BY_ID[ev.card]?.name}»` : '';
  switch (ev.t) {
    case 'start': return `${N(ev.by)} начинает: ${card}`;
    case 'draw': return `${bot}${N(ev.by)} берёт ${cardsWord(ev.cnt)}`;
    case 'pass': return `${bot}${N(ev.by)} пропускает ход: колода пуста`;
    case 'leave': return `${N(ev.by)} выходит из игры`;
    case 'play': {
      const head = `${bot}${N(ev.by)}: ${card}`;
      switch (ev.fx) {
        case 'skip': return `${head} — ${N(ev.victim)} пропускает ход`;
        case 'reverse': return `${head} — разворот!`;
        case 'draw2': return `${head} — ${N(ev.victim)} берёт ${cardsWord(ev.cnt ?? 2)} и пропускает ход`;
        case 'again': return `${head} — и ходит ещё раз`;
        case 'swap': return `${head} — обмен картами с игроком ${N(ev.victim)}`;
        default: return head;
      }
    }
    default: return '';
  }
}

// Крупная всплывашка по центру стола — только для заметных событий
function bannerFor(ev, names) {
  if (!ev) return null;
  const N = (id) => names[id] || 'Турист';
  if (ev.t === 'draw') return { icon: '🃏', text: `${N(ev.by)} берёт ${cardsWord(ev.cnt)}` };
  if (ev.t === 'leave') return { icon: '👋', text: `${N(ev.by)} выходит из игры` };
  if (ev.t !== 'play') return null;
  switch (ev.fx) {
    case 'skip': return { icon: '⏭️', text: `${N(ev.victim)} пропускает ход` };
    case 'reverse': return { icon: '🔄', text: 'Разворот!' };
    case 'draw2': return { icon: '➕', text: `${N(ev.victim)} берёт ${cardsWord(ev.cnt ?? 2)}` };
    case 'again': return { icon: '⚡', text: `${N(ev.by)} ходит ещё раз` };
    case 'swap': return { icon: '🔀', text: `${N(ev.by)} и ${N(ev.victim)} меняются картами` };
    default: return null;
  }
}

function fmtWait(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Свежие реплики игроков и зрителей
function activeNotices(game, now) {
  const s = game.state;
  return Object.entries(game.reactions)
    .map(([id, r]) => {
      if (!r || now - r.at > NOTICE_MS || now - r.at < -5000) return null;
      const emoji = r.e != null ? EMOJIS[r.e] : null;
      const text = emoji || PHRASES[r.i];
      const player = s.names[id];
      const name = player || (game.watchers[id] && game.watchers[id].name);
      if (!text || !name) return null;
      return { id, key: `${id}:${r.n ?? r.at}`, at: r.at, name, text, emoji: !!emoji, watcher: !player };
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

// Реплики показываем как push-уведомления на телефоне: их можно убрать тыком или смахнуть
function Notices({ list }) {
  const [closed, setClosed] = useState(() => new Set());
  const shown = list.filter((n) => !closed.has(n.key));
  if (!shown.length) return null;
  const close = (key) => setClosed((old) => new Set([...old].slice(-30)).add(key));
  return html`
    <div class="notices">
      ${shown.map((n) => html`<${Notice} key=${n.key} n=${n} onClose=${() => close(n.key)} />`)}
    </div>`;
}

const SWIPE_OUT = { up: '0 -160%', left: '-120% 0', right: '120% 0' };

function Notice({ n, onClose }) {
  const [drag, setDrag] = useState(null);
  const [out, setOut] = useState(null);
  const start = useRef(null);

  const down = (e) => {
    start.current = { x: e.clientX, y: e.clientY };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* не страшно */ }
  };
  const move = (e) => {
    if (!start.current) return;
    setDrag({ x: e.clientX - start.current.x, y: Math.min(0, e.clientY - start.current.y) });
  };
  const up = (e) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    start.current = null;
    const tap = Math.abs(dx) < 8 && Math.abs(dy) < 8;
    const side = Math.abs(dx) > 60;
    if (tap || side || dy < -30) {
      setOut(side ? (dx < 0 ? 'left' : 'right') : 'up');
      setTimeout(onClose, 180);
    } else {
      setDrag(null);
    }
  };
  const cancel = () => { start.current = null; setDrag(null); };

  const style = out
    ? `translate:${SWIPE_OUT[out]};transition:translate .18s ease-in`
    : drag ? `translate:${drag.x}px ${drag.y}px` : 'transition:translate .15s';
  return html`
    <div class="notice ${n.emoji ? 'emoji' : ''}" style=${style} title="Нажми или смахни, чтобы убрать"
         onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${cancel}>
      <div class="notice-ava">${n.watcher ? '👀' : avatar(n.id)}</div>
      <div class="notice-body">
        <div class="notice-head"><b>${n.name}${n.id === net.uid ? ' (ты)' : ''}</b><span>${n.watcher ? 'зритель · ' : ''}сейчас</span></div>
        <div class="notice-text">${n.text}</div>
      </div>
    </div>`;
}

function Seat({ id, s, presence, talking, now }) {
  const p = presence[id];
  const offline = !p || !p.on;
  const turn = s.turn === id;
  const count = s.hands[id].length;
  const since = (p && p.at) || s.t0 || s.at || now;
  const left = RECONNECT_GRACE_MS - (now - since);
  return html`
    <div class="seat ${turn ? 'turn' : ''} ${offline ? 'off' : ''}">
      <div class="seat-ava">
        ${avatar(id)}
        ${talking && html`<span class="seat-talk">💬</span>`}
        <span class="seat-count" title=${cardsLeft(count)}>${count}</span>
      </div>
      <div class="seat-name">${s.names[id]}</div>
      ${offline
        ? html`<div class="seat-note warn">${left > 0 ? `📵 ждём ${fmtWait(left)}` : '🤖 автоход'}</div>`
        : turn && html`<div class="seat-note">ходит…</div>`}
    </div>`;
}

function Hand({ cards, options, myTurn, selected, fresh, onPick }) {
  const box = useRef(null);
  const [[w, h], setSize] = useState([0, 0]);
  useLayoutEffect(() => {
    const el = box.current;
    const measure = () => setSize([el.clientWidth, window.innerHeight]);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const n = cards.length;
  // Размер карты подстраиваем под экран (в том числе под низкий альбомный), шаг — под число карт
  const cw = w ? Math.round(Math.min(132, Math.max(64, Math.min(w * 0.22, h * 0.2)))) : 100;
  let step = cw + 8;
  if (n > 1 && w) step = Math.min(cw + 8, Math.max(34, (w - cw - 16) / (n - 1)));
  return html`
    <div class="hand ${myTurn ? 'mine' : ''}" ref=${box}>
      <div class="hand-row" style=${`--cw:${cw}px;--step:${step}px`}>
        ${cards.map((id) => html`
          <${Card} key=${id} id=${id} onClick=${() => onPick(id)}
            class="small ${options.has(id) && myTurn ? 'ok' : myTurn ? 'no' : ''} ${selected === id ? 'sel' : ''} ${fresh.has(id) ? 'fresh' : ''}" />`)}
      </div>
    </div>`;
}

export function GameScreen({ roomId, room, game, connected, spectator, onExit, toast }) {
  const uid = net.uid;
  const s = game.state;
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState(null);
  const [swapCard, setSwapCard] = useState(null);
  const [busy, setBusy] = useState(false);
  const [phrases, setPhrases] = useState(false);
  const [rules, setRules] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [banner, setBanner] = useState(null);
  const [fresh, setFresh] = useState(new Set());
  const prevHand = useRef(null);
  const autoSeq = useRef(-1);
  const lastReact = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);

  const now = net.now();
  const playing = s.status === 'playing';
  const myTurn = playing && s.turn === uid;
  const top = topCard(s);
  const topType = CARD_BY_ID[top]?.type;
  const hand = useMemo(() => sortHand(s.hands[uid] || []), [s.hands[uid]?.join()]);
  const options = useMemo(() => new Set(hand.filter((c) => canPlay(c, top))), [hand, top]);
  const canDraw = myTurn && options.size === 0;

  // Соперники — в порядке хода, начиная со следующего за мной
  const seats = useMemo(() => {
    const i = s.order.indexOf(uid);
    if (i < 0) return s.order; // зритель видит всех
    return s.order.slice(i + 1).concat(s.order.slice(0, i));
  }, [s.order.join()]);

  // Новое событие: всплывашка, сброс выбора
  useEffect(() => {
    const b = bannerFor(s.last, s.names);
    setBanner(b ? { ...b, n: s.seq } : null);
    if (!b) return undefined;
    const t = setTimeout(() => setBanner(null), 2400);
    return () => clearTimeout(t);
  }, [s.seq]);

  useEffect(() => {
    if (!myTurn) { setSelected(null); setSwapCard(null); }
  }, [myTurn]);

  // Запоминаем виденные карты: сброс и свою руку, а в конце партии — и чужие руки
  useEffect(() => {
    const others = s.status === 'finished' ? Object.values(s.hands).flat() : [];
    remember([...others, ...(s.hands[uid] || []), ...s.pile]);
  }, [s.seq]);

  // Подсветка только что пришедших карт
  useEffect(() => {
    const cur = s.hands[uid] || [];
    const prev = prevHand.current;
    prevHand.current = cur;
    if (!prev) return undefined;
    const added = cur.filter((c) => !prev.includes(c));
    if (!added.length) return undefined;
    setFresh(new Set(added));
    const t = setTimeout(() => setFresh(new Set()), 1800);
    return () => clearTimeout(t);
  }, [hand]);

  // Автоход за отвалившегося игрока: ждём минуту с момента отключения
  useEffect(() => {
    if (!playing || !connected || s.turn === uid) return;
    const p = game.presence[s.turn];
    if (p && p.on) return;
    const since = (p && p.at) || s.t0 || s.at || now;
    const myRank = s.order.includes(uid) ? s.order.indexOf(uid) : s.order.length;
    if (now - since < RECONNECT_GRACE_MS) return;
    if (now - (s.at || 0) < AUTO_MOVE_DELAY_MS + myRank * 500) return;
    if (autoSeq.current === s.seq) return;
    autoSeq.current = s.seq;
    net.autoMove(roomId, s.seq).catch(() => { autoSeq.current = -1; });
  });

  // Страховка: если комната не узнала о конце игры
  useEffect(() => {
    if (s.status === 'finished' && room.status === 'playing') net.markFinished(roomId);
  }, [s.status, room.status]);

  async function act(fn) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      if (!res) toast('Ход не прошёл — попробуй ещё раз');
    } catch (e) {
      console.error(e);
      toast('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  }

  function playCard(id) {
    if (!myTurn || !options.has(id)) return;
    if (CARD_BY_ID[id].fx === 'swap' && hand.length > 1) {
      if (seats.length === 1) {
        setSelected(null);
        act(() => net.play(roomId, id, seats[0]));
      } else {
        setSwapCard(id);
      }
      return;
    }
    setSelected(null);
    act(() => net.play(roomId, id));
  }

  function pick(id) {
    if (selected === id && myTurn && options.has(id)) playCard(id);
    else setSelected(selected === id ? null : id);
  }

  function say(what) {
    setPhrases(false);
    if (Date.now() - lastReact.current < 1200) return;
    lastReact.current = Date.now();
    net.react(roomId, what).catch(() => {});
  }

  async function exit() {
    setConfirmExit(false);
    if (playing && !spectator) await net.leaveGame(roomId).catch(() => {});
    onExit();
  }

  const notices = activeNotices(game, now);
  const talking = new Set(notices.map((n) => n.id));
  const watchers = Object.values(game.watchers).map((w) => w.name).filter(Boolean);

  const need = topType === 'joker' ? null : NEXT[topType] || [];
  const turnName = s.names[s.turn];
  let status;
  if (!playing) status = 'Игра окончена';
  else if (myTurn) status = canDraw ? 'Твой ход — ходить нечем, тяни из колоды' : 'Твой ход!';
  else status = `Ходит ${turnName}`;

  const sel = selected && hand.includes(selected) ? selected : null;
  const selOk = sel && myTurn && options.has(sel);

  return html`
    <div class="game">
      <header class="g-top">
        <button class="btn ghost sm" onClick=${() => (playing && !spectator ? setConfirmExit(true) : exit())}>← Выйти</button>
        <div class="g-title">${room.name}${watchers.length > 0 && html`<span class="watchers" title=${'Смотрят: ' + watchers.join(', ')}>👀 ${watchers.length}</span>`}</div>
        <button class="btn ghost sm" onClick=${() => setRules(true)}>Правила</button>
      </header>

      <div class="seats">
        <div class="dir" title="Направление хода">${s.dir === 1 ? 'ход →' : '← ход'}</div>
        ${seats.map((id) => html`
          <${Seat} key=${id} id=${id} s=${s} presence=${game.presence} talking=${talking.has(id)} now=${now} />`)}
      </div>

      <div class="table" onClick=${() => setSelected(null)}><div class="table-in">
        <div class="deck ${canDraw ? 'pulse' : ''}" onClick=${(e) => { e.stopPropagation(); if (canDraw) act(() => net.draw(roomId)); }}
             role="button" aria-label="Колода">
          <${CardBack} />
          <span class="deck-count">${s.deck.length}</span>
          ${canDraw && html`<span class="deck-hint">Тяни!</span>`}
        </div>
        <div class="pile">
          ${s.pile.slice(-3, -1).map((id, i) => html`<${Card} key=${id} id=${id} class="under u${i}" />`)}
          <${Card} key=${top} id=${top} class="top" />
          ${banner && html`<div class="banner" key=${banner.n}><b>${banner.icon}</b>${banner.text}</div>`}
        </div>
        <div class="need">
          <span class="need-label">Дальше:</span>
          ${need
            ? need.concat('joker').map((t) => html`<span class="chip t-${t}">${TYPES[t].icon} ${TYPES[t].label}</span>`)
            : html`<span class="chip any">что угодно</span>`}
        </div>
      </div></div>

      <div class="statusbar ${myTurn ? 'mine' : ''}">
        <div class="status-main">${status}</div>
        <div class="status-last">${describe(s.last, s.names)}</div>
      </div>

      <div class="me-row">
        ${spectator
          ? html`<div class="me"><span class="me-ava">👀</span><span class="me-name">Ты смотришь игру</span></div>`
          : html`<div class="me">
              <span class="me-ava">${avatar(uid)}</span>
              <span class="me-name">${s.names[uid]}</span>
              <span class="me-count">${cardsLeft(hand.length)}</span>
            </div>`}
        <button class="btn sm say" onClick=${() => setPhrases(!phrases)}>💬 Сказать</button>
      </div>

      ${spectator
        ? html`<div class="hand spect">Когда партия закончится, ты попадёшь в следующую — если останешься на этом экране.</div>`
        : html`<${Hand} cards=${hand} options=${options} myTurn=${myTurn} selected=${sel} fresh=${fresh} onPick=${pick} />`}

      <${Notices} list=${notices} />

      ${phrases && html`
        <div class="overlay clear" onClick=${() => setPhrases(false)}>
          <div class="phrases" onClick=${(e) => e.stopPropagation()}>
            <div class="emojis">
              ${EMOJIS.map((e, i) => html`<button key=${i} onClick=${() => say({ e: i })}>${e}</button>`)}
            </div>
            ${PHRASES.map((p, i) => html`<button key=${i} onClick=${() => say({ i })}>${p}</button>`)}
          </div>
        </div>`}

      ${sel && !swapCard && html`
        <div class="preview-wrap">
          <div class="preview" key=${sel}>
            <button class="preview-close" onClick=${() => setSelected(null)} aria-label="Закрыть">✕</button>
            <${Card} id=${sel} class="big" onClick=${() => (selOk ? playCard(sel) : setSelected(null))} />
            ${selOk
              ? html`<button class="btn primary" disabled=${busy} onClick=${() => playCard(sel)}>Сыграть</button>`
              : html`<div class="preview-note">${myTurn ? 'Эту карту сейчас положить нельзя' : 'Сейчас не твой ход'}</div>`}
          </div>
        </div>`}

      ${swapCard && html`
        <${Modal} title="С кем меняемся картами?" onClose=${() => setSwapCard(null)}>
          <div class="targets">
            ${seats.map((id) => html`
              <button class="btn target" key=${id} disabled=${busy}
                onClick=${() => { const c = swapCard; setSwapCard(null); setSelected(null); act(() => net.play(roomId, c, id)); }}>
                <span>${avatar(id)} ${s.names[id]}</span>
                <span class="muted">${cardsLeft(s.hands[id].length)}</span>
              </button>`)}
          </div>
          <p class="muted">У тебя после хода останется ${cardsLeft(hand.length - 1)}.</p>
        <//>`}

      ${confirmExit && html`
        <${Modal} title="Выйти из игры?" onClose=${() => setConfirmExit(false)}>
          <p>Твои карты вернутся в колоду, а вернуться в эту партию будет нельзя.</p>
          <div class="row">
            <button class="btn" onClick=${() => setConfirmExit(false)}>Остаться</button>
            <button class="btn danger" onClick=${exit}>Выйти</button>
          </div>
        <//>`}

      ${rules && html`<${Rules} onClose=${() => setRules(false)} />`}

      ${s.status === 'finished' && html`<${Result} s=${s} roomId=${roomId} spectator=${spectator} onExit=${exit} toast=${toast} />`}

      ${!connected && html`<div class="offline-bar">📡 Нет связи — переподключаемся…</div>`}
    </div>`;
}

function Result({ s, roomId, spectator, onExit, toast }) {
  const uid = net.uid;
  const iWon = s.winner === uid;
  const others = Object.keys(s.names)
    .filter((id) => id !== s.winner)
    .map((id) => ({ id, name: s.names[id], n: s.hands[id].length, left: !s.order.includes(id) }))
    .sort((a, b) => a.left - b.left || a.n - b.n);
  const [busy, setBusy] = useState(false);
  async function again() {
    setBusy(true);
    try {
      await net.rematch(roomId);
    } catch {
      toast('Нет связи с сервером');
    }
    setBusy(false);
  }
  return html`
    <div class="overlay">
      <div class="modal result">
        <div class="result-plane">✈️</div>
        <h2>${iWon ? 'Ты улетаешь домой!' : `${s.names[s.winner] || 'Турист'} улетает домой!`}</h2>
        <p class="muted">${s.reason === 'left'
          ? 'Остальные разбрелись кто куда — победа за последним оставшимся.'
          : iWon ? 'Чемодан собран, сувениры куплены, магнитик на холодильник есть.' : 'А остальные ещё гуляют:'}</p>
        <ul class="result-list">
          ${others.map((o) => html`<li class=${o.id === uid ? 'me' : ''}>
            <span>${avatar(o.id)} ${o.name}</span>
            <span class="muted">${o.left ? 'вышел из игры' : `ещё ${cardsLeft(o.n)}`}</span>
          </li>`)}
        </ul>
        <div class="row">
          <button class="btn" onClick=${onExit}>В лобби</button>
          <button class="btn primary" disabled=${busy} onClick=${again}>${spectator ? 'Играть следующую' : 'Ещё партию'}</button>
        </div>
      </div>
    </div>`;
}
