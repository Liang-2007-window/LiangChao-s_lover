// Diary entry <-> row mapping. Everything but the date lives inside the sealed
// payload, so a stolen database file exposes the day count and nothing else.
import { decryptText, encryptText } from './security.mjs';

export function sealEntry(input) {
  const payload = JSON.stringify({
    t: input.title || '',
    w: input.weather || '',
    m: input.mood || '',
    b: input.body || '',
  });
  const sealed = encryptText(payload);
  return { date: input.date, ct: sealed.ct, iv: sealed.iv, tag: sealed.tag };
}

export function openEntry(row) {
  let payload = {};
  try {
    payload = JSON.parse(decryptText(row));
  } catch {
    // Body sealed with a different master key: show the row, not the content.
    payload = {};
  }
  return {
    id: row.id,
    date: row.date,
    title: payload.t || '',
    weather: payload.w || '',
    mood: payload.m || '',
    body: payload.b || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}