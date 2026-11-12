// Корень приложения: имя → лобби → комната → игра
import { html, render, useState, useEffect, useRef, useCallback } from './vendor/preact.js';
import * as net from './net.js';
import { MIN_PLAYERS, MAX_PLAYERS } from './rules.js';
import { CARDS } from './cards.js';
import { GameScreen } from './game.js';
import { Rules, Credits, Deck, avatar, plural } from './ui.js';

const TITLE = 'Ну долго ещё?';
const TAGLINE = 'Карточная игра про неопытных туристов';

const load = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const save = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* приватный режим */ } };
const cleanName = (v) => v.replace(/\s+/g, ' ').trim().slice(0, 16);

function App() {
  const [name, setNameState] = useState(() => cleanName(load('tc_name')));
  const [roomId, setRoomState] = useState(() => load('tc_room') || null);
  const [watching, setWatchState] = useState(() => !!load('tc_room') && load('tc_watch') === '1');
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [people, setPeople] = useState({});
  const [rooms, setRooms] = useState(null);
  const [room, setRoom] = useState(undefined); // undefined – грузится, null – нет такой
  const [game, setGame] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const joining = useRef(false);
  const roomRef = useRef(roomId);
  roomRef.current = roomId;

  const setName = (v) => { save('tc_name', v); setNameState(v); };
  const setWatching = (v) => { save('tc_watch', v ? '1' : ''); setWatchState(!!v); };
  const setRoomId = (v, watch = false) => {
    save('tc_room', v); setWatching(v && watch); setRoom(undefined); setGame(null); setRoomState(v);
  };

  const toast = useCallback((text) => {
    const id = Math.random();
    setToasts((t) => t.concat({ id, text }).slice(-3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  useEffect(() => net.onConnected((on) => { setConnected(on); if (on) setEverConnected(true); }), []);

  useEffect(() => {
    if (!name) return undefined;
    const a = net.watchLobby(setPeople);
    const b = net.watchRooms(setRooms);
    return () => { a(); b(); };
  }, [!!name]);

  useEffect(() => {
    if (!roomId) return undefined;
    return net.watchRoom(roomId, setRoom);
  }, [roomId]);

  const status = room ? room.status : null;
  const inRoom = !!(room && room.players && room.players[net.uid]);
  const inGame = status === 'playing' || status === 'finished';

  useEffect(() => {
    if (!roomId || !inGame) return undefined;
    return net.watchGame(roomId, setGame);
  }, [roomId, inGame]);
  // Состояние от прошлой партии в этой же комнате не считается
  const live = game && game.state && room && game.state.round === room.round ? game : null;

  // Присутствие: обновляем при каждом подключении и смене экрана
  useEffect(() => {
    if (!connected || !name) return;
    net.arm({ name, roomId: room ? roomId : null, status, inRoom, watching });
  }, [connected, name, roomId, status, inRoom, !!room, watching]);

  // Зритель, попавший в комнату, становится обычным игроком
  useEffect(() => {
    if (watching && inRoom && status === 'waiting') setWatching(false);
  }, [watching, inRoom, status]);

  // Комната исчезла / нас в ней нет
  useEffect(() => {
    if (!roomId || room === undefined || !name) return;
    if (room === null) {
      setRoomId(null);
      return;
    }
    if (status === 'waiting' && !inRoom && !joining.current) {
      // Отвалились из ожидающей комнаты или началась «ещё партия» — возвращаемся в неё
      // Зрители заходят чуть позже, чтобы места сначала достались тем, кто играл
      joining.current = true;
      const id = roomId;
      setTimeout(() => {
        if (roomRef.current !== id) { joining.current = false; return; }
        net.joinRoom(id, name)
          .then((ok) => { if (!ok && roomRef.current === id) { setRoomId(null); toast('В этой игре больше нет места'); } })
          .catch(() => { if (roomRef.current === id) setRoomId(null); })
          .finally(() => { joining.current = false; });
      }, watching ? 1500 : 0);
    }
  }, [roomId, room, status, inRoom, name]);

  // Игра идёт, но мы в ней не участвуем
  useEffect(() => {
    if (!roomId || !inGame || !live || watching) return;
    const s = live.state;
    if (!s.names[net.uid]) {
      // Не успели в раздачу — остаёмся зрителем и попадём в следующую партию
      setWatching(true);
      net.dropSeat(roomId);
      toast('Игра началась без тебя — пока можно посмотреть');
    } else if (s.status === 'playing' && !s.order.includes(net.uid)) {
      setRoomId(null);
    }
  }, [roomId, inGame, live, watching]);

  // Уборка заброшенных комнат
  useEffect(() => {
    if (!rooms || !connected) return undefined;
    const t = setTimeout(() => net.cleanup(rooms), 4000);
    return () => clearTimeout(t);
  }, [rooms, connected]);

  async function create() {
    try {
      setRoomId(await net.createRoom(name));
    } catch (e) {
      console.error(e);
      toast('Не получилось создать игру');
    }
  }

  async function join(id) {
    try {
      if (await net.joinRoom(id, name)) setRoomId(id);
      else toast('Не получилось войти: игра уже началась или мест нет');
    } catch (e) {
      console.error(e);
      toast('Нет связи с сервером');
    }
  }

  async function leave() {
    const id = roomId;
    const wasWatching = watching;
    setRoomId(null);
    if (!id) return;
    if (wasWatching) await net.unwatch(id);
    else await net.leaveRoom(id).catch(() => {});
  }

  // Новичку, который впервые представился, сразу показываем правила
  function register(v) {
    setName(v);
    if (!load('tc_rules_seen')) {
      save('tc_rules_seen', '1');
      setDialog('welcome');
    }
  }

  function rename() {
    net.leaveLobby().catch(() => {});
    setName('');
  }

  let screen;
  if (!name) {
    screen = html`<${NameScreen} onDone=${register} onDialog=${setDialog} />`;
  } else if (!everConnected) {
    screen = html`<${Splash} text="Подключаемся…" />`;
  } else if (!roomId) {
    screen = html`<${Lobby} name=${name} people=${people} rooms=${rooms} connected=${connected}
      onCreate=${create} onJoin=${join} onWatch=${(id) => setRoomId(id, true)} onRename=${rename} onDialog=${setDialog} />`;
  } else if (!room || (status === 'waiting' && !inRoom)) {
    screen = html`<${Splash} text="Заходим…" />`;
  } else if (status === 'waiting') {
    screen = html`<${RoomScreen} room=${room} roomId=${roomId} connected=${connected} onLeave=${leave} toast=${toast} />`;
  } else if (!live) {
    screen = html`<${Splash} text="Раздаём карты…" />`;
  } else {
    screen = html`<${GameScreen} key=${roomId + ':' + room.round} roomId=${roomId} room=${room} game=${live} connected=${connected} spectator=${watching}
      onExit=${leave} toast=${toast} />`;
  }

  return html`
    ${screen}
    ${(dialog === 'rules' || dialog === 'welcome') && html`<${Rules} welcome=${dialog === 'welcome'} onClose=${() => setDialog(null)} />`}
    ${dialog === 'credits' && html`<${Credits} onClose=${() => setDialog(null)} />`}
    ${dialog === 'deck' && html`<${Deck} onClose=${() => setDialog(null)} />`}
    <div class="toasts">${toasts.map((t) => html`<div class="toast" key=${t.id}>${t.text}</div>`)}</div>`;
}

function Splash({ text }) {
  return html`<div class="boot">🧳<span>${text}</span></div>`;
}

function Logo() {
  return html`
    <div class="logo">
      <div class="logo-icons"><span>📸</span><span>🍜</span><span>🧋</span><span>🚽</span></div>
      <h1>${TITLE}</h1>
      <p>${TAGLINE}</p>
    </div>`;
}

function Footer({ onDialog }) {
  return html`
    <footer class="foot">
      <button class="link" onClick=${() => onDialog('rules')}>Правила</button>
      <span>·</span>
      <button class="link" onClick=${() => onDialog('deck')}>Все карты</button>
      <span>·</span>
      <button class="link" onClick=${() => onDialog('credits')}>Авторы фото</button>
    </footer>`;
}

function NameScreen({ onDone, onDialog }) {
  const [v, setV] = useState('');
  const submit = (e) => {
    e.preventDefault();
    const n = cleanName(v);
    if (n) onDone(n);
  };
  return html`
    <div class="page center">
      <${Logo} />
      <form class="panel name-form" onSubmit=${submit}>
        <label for="name">Как тебя зовут, турист?</label>
        <input id="name" value=${v} onInput=${(e) => setV(e.target.value)} maxlength="16"
               placeholder="Имя" autocomplete="nickname" autofocus />
        <button class="btn primary" disabled=${!cleanName(v)}>Поехали!</button>
        <p class="muted">Без регистрации. В колоде ${CARDS.length} карт, играют от ${MIN_PLAYERS} до ${MAX_PLAYERS} человек.</p>
      </form>
      <${Footer} onDialog=${onDialog} />
    </div>`;
}

function Lobby({ name, people, rooms, connected, onCreate, onJoin, onWatch, onRename, onDialog }) {
  const list = Object.entries(rooms || {})
    .map(([id, r]) => ({ id, ...r, players: r.players || {} }))
    .filter((r) => r.status === 'playing' || (r.status === 'waiting' && Object.keys(r.players).length))
    .sort((a, b) => (a.status === 'waiting' ? 0 : 1) - (b.status === 'waiting' ? 0 : 1) || (b.createdAt || 0) - (a.createdAt || 0));
  const roomName = (id) => (rooms && rooms[id] ? rooms[id].name : null);
  const online = Object.entries(people).sort((a, b) => a[1].name.localeCompare(b[1].name, 'ru'));

  return html`
    <div class="page lobby">
      <header class="lobby-head">
        <${Logo} />
        <div class="whoami">
          <span>${avatar(net.uid)} <b>${name}</b></span>
          <button class="link" onClick=${onRename}>сменить имя</button>
        </div>
      </header>

      <div class="lobby-grid">
        <section class="panel">
          <div class="panel-head">
            <h2>Игры</h2>
            <button class="btn primary" onClick=${onCreate} disabled=${!connected}>+ Создать игру</button>
          </div>
          ${rooms === null && html`<p class="muted">Загружаем…</p>`}
          ${rooms !== null && !list.length && html`
            <div class="empty">
              <div>🏝️</div>
              <p>Пока никто не играет.<br />Создай игру и позови друзей!</p>
            </div>`}
          <ul class="rooms">
            ${list.map((r) => {
              const ps = Object.entries(r.players);
              const waiting = r.status === 'waiting';
              const full = ps.length >= MAX_PLAYERS;
              return html`
                <li class="room ${waiting ? 'waiting' : 'playing'}" key=${r.id}>
                  <div class="room-info">
                    <div class="room-name">${r.name}</div>
                    <div class="room-players">
                      ${ps.map(([id, p]) => html`<span class="pill" key=${id}>${avatar(id)} ${p.name}</span>`)}
                    </div>
                  </div>
                  <div class="room-side">
                    ${waiting
                      ? html`<span class="tag wait">ждёт игроков · ${ps.length}/${MAX_PLAYERS}</span>
                             <button class="btn" disabled=${full || !connected} onClick=${() => onJoin(r.id)}>
                               ${full ? 'Мест нет' : 'Войти'}</button>`
                      : html`<span class="tag play">идёт игра</span>
                             <button class="btn" disabled=${!connected} onClick=${() => onWatch(r.id)}>👀 Смотреть</button>`}
                  </div>
                </li>`;
            })}
          </ul>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>Сейчас онлайн <span class="count">${online.length}</span></h2></div>
          <ul class="people">
            ${online.map(([id, p]) => html`
              <li key=${id} class=${id === net.uid ? 'me' : ''}>
                <span>${avatar(id)} ${p.name}${id === net.uid ? ' (ты)' : ''}</span>
                <span class="muted">${p.room && roomName(p.room) ? `${p.watch ? 'смотрит' : 'в'} «${roomName(p.room)}»` : 'в лобби'}</span>
              </li>`)}
          </ul>
        </section>
      </div>
      <${Footer} onDialog=${onDialog} />
      ${!connected && html`<div class="offline-bar">📡 Нет связи — переподключаемся…</div>`}
    </div>`;
}

function RoomScreen({ room, roomId, connected, onLeave, toast }) {
  const players = Object.entries(room.players || {}).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const host = net.hostOf(room);
  const iAmHost = host === net.uid;
  const enough = players.length >= MIN_PLAYERS;
  const [busy, setBusy] = useState(false);
  const slots = Array.from({ length: MAX_PLAYERS }, (_, i) => players[i] || null);

  async function start() {
    setBusy(true);
    try {
      if (!(await net.startGame(roomId))) toast('Не получилось начать игру');
    } catch (e) {
      console.error(e);
      toast('Нет связи с сервером');
    }
    setBusy(false);
  }

  const need = MIN_PLAYERS - players.length;
  return html`
    <div class="page center">
      <div class="panel room-panel">
        <div class="panel-head">
          <h2>${room.name}</h2>
          <button class="btn ghost sm" onClick=${onLeave}>← В лобби</button>
        </div>
        <p class="muted">Собираем группу: ${players.length} из ${MAX_PLAYERS}. Друзьям достаточно открыть эту же страницу и нажать «Войти».</p>
        <ul class="slots">
          ${slots.map((p, i) => p
            ? html`<li class="slot taken" key=${p[0]}>
                <span class="slot-ava">${avatar(p[0])}</span>
                <span class="slot-name">${p[1].name}${p[0] === net.uid ? ' (ты)' : ''}</span>
                ${p[0] === host && html`<span class="tag">ведущий</span>`}
              </li>`
            : html`<li class="slot" key=${i}><span class="slot-ava">＋</span><span class="slot-name muted">свободное место</span></li>`)}
        </ul>
        ${iAmHost
          ? html`<button class="btn primary big" disabled=${!enough || busy || !connected} onClick=${start}>
              ${enough ? 'Начать игру' : `Нужен ещё ${need} ${plural(need, 'игрок', 'игрока', 'игроков')}`}</button>`
          : html`<p class="waiting-note">⏳ Ждём, пока ${room.players[host]?.name || 'ведущий'} начнёт игру…</p>`}
      </div>
      ${!connected && html`<div class="offline-bar">📡 Нет связи — переподключаемся…</div>`}
    </div>`;
}

const root = document.getElementById('app');
root.textContent = '';
render(html`<${App} />`, root);
