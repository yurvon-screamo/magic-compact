// Omission-кэш (PLAN.md, срез 2): вырезанное живёт вне контекста, retrievable.
// Content-ID = sha256(содержимого) — стабильный между rewrite (AGENTS.md-замечание
// ревьюера: id сообщений исчезают, хэш содержимого — нет).
// Retention: последние 2 компакшна (generations); miss → ОПРЕДЕЛЁННОЕ «не найдено».
import { createHash } from "node:crypto";

export type OmissionEntry = {
  contentID: string;
  toolName: string;
  content: string; // оригинальный вырезанный текст
  createdAt: number;
  generation: number;
};

export type OmissionStore = {
  entries: Map<string, OmissionEntry>; // contentID → entry
  generation: number; // номер текущего компакшна
};

export const newStore = (generation = 1): OmissionStore => ({
  entries: new Map(),
  generation,
});

export const contentId = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex").slice(0, 24);

export const put = (
  store: OmissionStore,
  toolName: string,
  content: string,
): string => {
  const id = contentId(content);
  store.entries.set(id, {
    contentID: id,
    toolName,
    content,
    createdAt: Date.now(),
    generation: store.generation,
  });
  return id;
};

export type LookupResult =
  | { found: true; entry: OmissionEntry }
  | { found: false; reason: "evicted" | "unknown" };

export const lookup = (
  store: OmissionStore,
  contentID: string,
): LookupResult => {
  const e = store.entries.get(contentID);
  if (e) return { found: true, entry: e };
  // в кэше что-то есть → id был, но вытеснен; пусто → никогда не существовал
  return {
    found: false,
    reason: store.entries.size > 0 ? "evicted" : "unknown",
  };
};

/** Ответ тула read_omitted_content: определённый «не найдено», не падение. */
export const retrievalAnswer = (
  store: OmissionStore,
  contentID: string,
): string => {
  const r = lookup(store, contentID);
  if (r.found) return r.entry.content;
  return r.reason === "evicted"
    ? `Содержимое ${contentID} вытеснено политикой retention (хранятся последние 2 компакшна). Восстанови источник повторным вызовом исходного тула.`
    : `Content-ID ${contentID} не найден: такого вырезания не было. Проверь ID из omission-нотиса.`;
};

/** Переход к следующему компакшну: вытеснять всё старше последних 2 поколений. */
export const advanceGeneration = (store: OmissionStore) => {
  store.generation += 1;
  const keepFrom = store.generation - 1; // текущее + предыдущее
  for (const [id, e] of store.entries)
    if (e.generation < keepFrom) store.entries.delete(id);
};
