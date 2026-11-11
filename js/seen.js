// Память о недавно виденных картах (в этом браузере): чтобы в следующих партиях
// сначала приходили карты, которые давно не попадались.
import { CARDS } from './cards.js';
import { SEEN_SHARE } from './rules.js';

const KEY = 'tc_seen';

export function recall() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Список упорядочен от давно виденных к только что виденным
export function remember(ids) {
  const fresh = new Set(ids);
  if (!fresh.size) return;
  const list = recall().filter((id) => !fresh.has(id)).concat([...fresh]);
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-Math.floor(CARDS.length * SEEN_SHARE))));
  } catch { /* приватный режим */ }
}
