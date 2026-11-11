// Общие кирпичики интерфейса
import { html, useEffect } from './vendor/preact.js';
import { CARD_BY_ID, TYPES, FX } from './cards.js';
import { CREDITS } from './credits.js';

const AVATARS = ['🧳', '🎒', '🕶️', '🩴', '📷', '🗺️', '🌴', '🥥', '🛵', '🏝️', '🧢', '🩳', '⛱️', '🧭', '🚌', '🎫'];
export function avatar(uid) {
  let h = 0;
  for (const ch of String(uid)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
export const cardsWord = (n) => `${n} ${plural(n, 'карту', 'карты', 'карт')}`;
export const cardsLeft = (n) => `${n} ${plural(n, 'карта', 'карты', 'карт')}`;

export function Card({ id, class: cls = '', onClick, style }) {
  const c = CARD_BY_ID[id];
  if (!c) return null;
  const type = TYPES[c.type];
  return html`
    <div class="card t-${c.type} ${cls}" onClick=${onClick} style=${style} data-card=${id}>
      <div class="card-in">
        <div class="card-pic">
          <span class="card-emoji">${type.icon}</span>
          <img src="img/cards/${id}.webp" alt="" draggable=${false}
               onError=${(e) => { e.target.style.display = 'none'; }} />
          <span class="card-corner">${type.icon}</span>
          ${c.place && html`<span class="card-place">📍 ${c.place}</span>`}
          ${c.fx && html`<span class="card-badge" title=${FX[c.fx].title}>${FX[c.fx].icon}</span>`}
        </div>
        <div class="card-body">
          <div class="card-type">${type.label}</div>
          <div class="card-name">${c.name}</div>
          <div class="card-text">${c.text}</div>
          ${c.fx && html`<div class="card-fx"><b>${FX[c.fx].icon}</b> ${FX[c.fx].text}</div>`}
        </div>
      </div>
    </div>`;
}

export function CardBack({ class: cls = '', style }) {
  return html`<div class="card back ${cls}" style=${style}><div class="card-in"><span>🧳</span></div></div>`;
}

export function Modal({ title, onClose, children, class: cls = '' }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && onClose) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return html`
    <div class="overlay" onClick=${(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div class="modal ${cls}" role="dialog" aria-modal="true">
        ${title && html`<div class="modal-head">
          <h2>${title}</h2>
          ${onClose && html`<button class="icon-btn" onClick=${onClose} aria-label="Закрыть">✕</button>`}
        </div>`}
        <div class="modal-body">${children}</div>
      </div>
    </div>`;
}

export function Rules({ onClose }) {
  const chip = (t) => html`<span class="chip t-${t}">${TYPES[t].icon} ${TYPES[t].label}</span>`;
  return html`
    <${Modal} title="Правила" onClose=${onClose} class="rules">
      <p>Вы — неопытные туристы. Посмотрели достопримечательность — захотелось есть.
         Поели — захотелось пить. Попили — срочно ищем туалет. И по кругу.</p>
      <p><b>Цель:</b> первым избавиться от всех карт и улететь домой.</p>
      <h3>Что на что кладётся</h3>
      <ul class="cycle">
        <li>${chip('sight')} <i>→</i> ${chip('food')} или ${chip('drink')}</li>
        <li>${chip('food')} <i>→</i> ${chip('drink')} или ${chip('toilet')}</li>
        <li>${chip('drink')} <i>→</i> ${chip('toilet')}</li>
        <li>${chip('toilet')} <i>→</i> ${chip('sight')}</li>
        <li>${chip('joker')} кладётся на любую карту, и на него — любая</li>
      </ul>
      <h3>Ход</h3>
      <p>Ходим по очереди, по одной карте. Нечем ходить — тянешь карты из колоды,
         пока не попадётся подходящая, и кладёшь её.</p>
      <h3>Карты с эффектами</h3>
      <ul class="fx-list">
        ${Object.values(FX).map((f) => html`<li><b>${f.icon} ${f.title}.</b> ${f.text}.</li>`)}
      </ul>
      <p class="muted">Вдвоём «Разворот» работает как пропуск хода соперника.
         Если игрок отвалился, его ждут минуту, а потом ходят за него автоматически.</p>
    <//>`;
}

export function Credits({ onClose }) {
  const ids = Object.keys(CREDITS);
  return html`
    <${Modal} title="Фотографии" onClose=${onClose} class="credits">
      <p class="muted">Все фотографии взяты с Wikimedia Commons и используются по свободным лицензиям.
         Изображения обрезаны и уменьшены.</p>
      <ul>
        ${ids.map((id) => {
          const c = CREDITS[id];
          const card = CARD_BY_ID[id];
          if (!card) return null;
          return html`<li>
            <a href=${c.p} target="_blank" rel="noopener">${card.name}</a> — ${c.a || 'автор не указан'},
            ${' '}${c.lu ? html`<a href=${c.lu} target="_blank" rel="noopener">${c.l}</a>` : c.l || 'свободная лицензия'}
          </li>`;
        })}
      </ul>
    <//>`;
}
