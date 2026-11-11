// Служебная страница review.html: просмотр всех картинок колоды, пометки и выбор замены.
// Пометки сохраняются в Firebase (test/review) и дублируются в localStorage.
import { html, render, useState, useEffect, useRef, useMemo } from './vendor/preact.js';
import { initializeApp, getDatabase, ref, onValue, set, remove } from './vendor/firebase.js';
import { DATABASE_URL } from './config.js';
import { CARDS, TYPES, FX } from './cards.js';

const db = getDatabase(initializeApp({ databaseURL: DATABASE_URL }));
const PATH = 'test/review';
const LS_KEY = 'tc_review';

// Миниатюра с Wikimedia Commons по названию файла
const thumb = (title, w = 330) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title.replace(/^File:/, ''))}?width=${w}`;
const commonsPage = (title) => `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

const isEmpty = (m) => !m || (!m.bad && !m.pick && !(m.note || '').trim());

function loadLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}

function App() {
  const [cands, setCands] = useState(null);
  const [marks, setMarks] = useState(loadLocal);
  const [sync, setSync] = useState('wait'); // wait | ok | err
  const [filter, setFilter] = useState('all');
  const [type, setType] = useState('all');
  const [open, setOpen] = useState(null);
  const [zoom, setZoom] = useState(null);
  const [toast, setToast] = useState('');
  const timers = useRef({});

  useEffect(() => {
    fetch('review/candidates.json').then((r) => r.json()).then(setCands).catch(() => setCands({}));
    return onValue(ref(db, PATH), (s) => {
      setSync('ok');
      const remote = s.val() || {};
      setMarks(remote);
      try { localStorage.setItem(LS_KEY, JSON.stringify(remote)); } catch { /* приватный режим */ }
    }, () => setSync('err'));
  }, []);

  function save(id, next) {
    const node = ref(db, `${PATH}/${id}`);
    const p = isEmpty(next)
      ? remove(node)
      : set(node, { bad: !!next.bad, pick: next.pick || null, note: (next.note || '').trim() || null, name: CARDS.find((c) => c.id === id).name });
    p.then(() => setSync('ok')).catch(() => setSync('err'));
  }

  // delay – для текста комментария, чтобы не писать в базу на каждую букву
  function update(id, patch, delay = 0) {
    setMarks((all) => {
      const next = { ...(all[id] || {}), ...patch };
      const copy = { ...all, [id]: next };
      if (isEmpty(next)) delete copy[id];
      try { localStorage.setItem(LS_KEY, JSON.stringify(copy)); } catch { /* приватный режим */ }
      clearTimeout(timers.current[id]);
      timers.current[id] = setTimeout(() => save(id, next), delay);
      return copy;
    });
  }

  const say = (t) => { setToast(t); setTimeout(() => setToast(''), 2500); };

  function summary() {
    const lines = CARDS.filter((c) => !isEmpty(marks[c.id])).map((c) => {
      const m = marks[c.id];
      const parts = [];
      if (m.bad) parts.push('плохая');
      if (m.pick) parts.push(`заменить на: ${m.pick}`);
      if (m.note) parts.push(`комментарий: ${m.note}`);
      return `${c.id} («${c.name}») — ${parts.join('; ')}`;
    });
    return lines.join('\n') || 'Пометок нет.';
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(summary());
      say('Список скопирован');
    } catch {
      window.prompt('Скопируй текст:', summary());
    }
  }

  const counts = useMemo(() => {
    const vals = Object.values(marks);
    return {
      marked: vals.filter((m) => !isEmpty(m)).length,
      bad: vals.filter((m) => m.bad).length,
      pick: vals.filter((m) => m.pick).length,
      note: vals.filter((m) => (m.note || '').trim()).length,
    };
  }, [marks]);

  const visible = CARDS.filter((c) => {
    if (type !== 'all' && c.type !== type) return false;
    const m = marks[c.id];
    if (filter === 'marked') return !isEmpty(m) || open === c.id;
    if (filter === 'clean') return isEmpty(m) || open === c.id;
    return true;
  });

  const Chip = ({ value, cur, on, children }) =>
    html`<button class="chip ${cur === value ? 'on' : ''}" onClick=${() => on(value)}>${children}</button>`;

  return html`
    <div class="bar"><div class="bar-in">
      <h1>🔍 Проверка картинок</h1>
      <div class="stats">карт: <b>${CARDS.length}</b> · помечено: <b>${counts.marked}</b>
        ${' '}(плохих <b>${counts.bad}</b>, с заменой <b>${counts.pick}</b>, с комментарием <b>${counts.note}</b>)</div>
      <span class="sync ${sync === 'err' ? 'err' : ''}">${sync === 'ok' ? '✓ сохранено' : sync === 'err' ? '⚠ нет связи, пометки только в этом браузере' : '… подключаемся'}</span>
      <div class="spacer"></div>
      <div class="chips">
        <${Chip} value="all" cur=${filter} on=${setFilter}>Все<//>
        <${Chip} value="marked" cur=${filter} on=${setFilter}>Помеченные <small>${counts.marked}</small><//>
        <${Chip} value="clean" cur=${filter} on=${setFilter}>Без пометок<//>
      </div>
      <div class="chips">
        <${Chip} value="all" cur=${type} on=${setType}>Все типы<//>
        ${Object.keys(TYPES).map((t) => html`<${Chip} key=${t} value=${t} cur=${type} on=${setType}>${TYPES[t].icon}<//>`)}
      </div>
      <button class="btn primary" onClick=${copy}>Скопировать итог</button>
    </div></div>

    <div class="wrap">
      <div class="help">
        <b>Как пользоваться.</b> Клик по картинке — увеличить. «👎 Плохая» — пометить картинку.
        «Варианты» — показать другие фото, найденные на Wikimedia Commons для этой карты; клик по варианту выбирает его на замену.
        В комментарии можно написать что угодно: что не так, что хотелось бы видеть или ссылку на свою картинку.
        Пометки сохраняются сами. Когда закончишь — просто напиши в чат, я заберу их отсюда.
      </div>
      ${Object.keys(TYPES).filter((t) => type === 'all' || type === t).map((t) => {
        const list = visible.filter((c) => c.type === t);
        if (!list.length) return null;
        return html`
          <h2 class="t-${t}">${TYPES[t].icon} ${TYPES[t].label} <span>${list.length}</span></h2>
          <div class="grid">
            ${list.map((c) => html`<${Tile} key=${c.id} card=${c} mark=${marks[c.id] || {}} info=${cands && cands[c.id]}
              open=${open === c.id} onOpen=${() => setOpen(open === c.id ? null : c.id)} onZoom=${setZoom} update=${update} />`)}
          </div>`;
      })}
      ${!visible.length && html`<div class="empty">Тут пусто.</div>`}
    </div>
    ${zoom && html`<div class="zoom" onClick=${() => setZoom(null)}><img src=${zoom} alt="" /></div>`}
    ${toast && html`<div class="toast">${toast}</div>`}`;
}

function Tile({ card, mark, info, open, onOpen, onZoom, update }) {
  const cur = info && info.current;
  const list = (info && info.cands) || [];
  const picked = mark.pick && mark.pick !== cur ? mark.pick : null;
  const src = picked ? thumb(picked, 500) : `img/cards/${card.id}.webp`;
  const pick = (title) => update(card.id, { pick: title === cur || title === mark.pick ? null : title });

  return html`
    <div class="tile t-${card.type} ${mark.bad ? 'bad' : picked ? 'changed' : ''} ${open ? 'open' : ''}" id=${card.id}>
      <div class="tile-main">
        <div class="pic" onClick=${() => onZoom(picked ? thumb(picked, 960) : src)}>
          <img src=${src} alt=${card.name} loading="lazy" />
          ${mark.bad && html`<span class="flag">плохая</span>`}
          ${picked && html`<span class="flag new" style=${mark.bad ? 'top:34px' : ''}>замена выбрана</span>`}
        </div>
        <div class="info">
          <div class="type">${TYPES[card.type].label}${card.place ? ' · ' + card.place : ''}</div>
          <div class="name">${card.name}</div>
          <div class="text">${card.text}</div>
          ${card.fx && html`<div class="fx">${FX[card.fx].icon} ${FX[card.fx].title}</div>`}
          <div class="actions">
            <button class="act bad ${mark.bad ? 'on' : ''}" onClick=${() => update(card.id, { bad: !mark.bad })}>👎 Плохая</button>
            <button class="act alt ${open ? 'on' : ''}" onClick=${onOpen}>Варианты${list.length ? ` (${list.length})` : ''}</button>
          </div>
          <textarea rows="1" placeholder="Комментарий…" value=${mark.note || ''}
            onInput=${(e) => update(card.id, { note: e.target.value }, 600)}></textarea>
          <div class="src">${card.id}${cur ? html` · <a href=${commonsPage(cur)} target="_blank" rel="noopener">оригинал</a>` : ''}</div>
        </div>
      </div>
      ${open && html`
        <div class="alts">
          <div class="alts-head">Запрос на Wikimedia Commons: «${info ? info.query : '…'}». Клик — выбрать на замену, повторный клик — отменить.</div>
          <div class="alts-grid">
            ${list.map((c) => html`
              <button class="alt ${c.t === cur ? 'cur' : ''} ${c.t === picked ? 'sel' : ''}" key=${c.t} onClick=${() => pick(c.t)} title=${c.t}>
                <img src=${thumb(c.t)} alt="" loading="lazy" />
                ${c.t === cur && html`<span class="tag">сейчас</span>`}
                ${c.t === picked && html`<span class="tag">замена</span>`}
                <div class="meta"><span>${c.a || '—'}</span><span>${c.l}</span></div>
              </button>`)}
          </div>
        </div>`}
    </div>`;
}

const root = document.getElementById('app');
root.textContent = '';
render(html`<${App} />`, root);
