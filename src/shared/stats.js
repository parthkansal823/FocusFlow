// Block statistics. Days are keyed by the user's *local* date, so "today"
// resets at local midnight (the old version used UTC and reset at 5:30 AM IST).

import { LIMITS } from "./defaults.js";

export function localDateKey(time) {
  const d = new Date(time);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function emptyStats() {
  return { total: 0, days: {} };
}

export function recordBlock(stats, now) {
  const base = stats && typeof stats === "object" ? stats : emptyStats();
  const today = localDateKey(now);
  const days = { ...(base.days || {}) };
  days[today] = (days[today] || 0) + 1;

  const keep = new Set(lastDays(now, LIMITS.statsDays).map(d => d.key));
  for (const key of Object.keys(days)) {
    if (!keep.has(key)) delete days[key];
  }
  return { total: (base.total || 0) + 1, days };
}

export function lastDays(now, count) {
  const out = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0); // midday avoids DST edge cases when stepping back
  for (let i = count - 1; i >= 0; i--) {
    const day = new Date(d);
    day.setDate(d.getDate() - i);
    out.push({ key: localDateKey(day.getTime()), date: day });
  }
  return out;
}

export function countForDay(stats, now) {
  return (stats && stats.days && stats.days[localDateKey(now)]) || 0;
}

export function appendHistory(history, entry) {
  const list = Array.isArray(history) ? history : [];
  return [...list, entry].filter(item => item.at >= entry.at - LIMITS.historyTtlMs && item.at <= entry.at).slice(-LIMITS.historyEntries);
}
