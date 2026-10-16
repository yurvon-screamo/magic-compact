// Arkive V2 — плагин OpenCode V2 (срезы 3–4, ревью v2).
// Путь А (ADR-001): нативный compaction-hook + капсулы через ctx.generate.text.
// Инвариант границ (ревью High#2): hook капсулирует ВЕСЬ event.messages — сервер
// уже отрезал свой verbatim recent-хвост (compaction.keep.tokens); зазора нет.
// Trim: roundtrip-транспорт (transport.ts) — write-ahead omission, dead-letter.
import { Plugin } from "@opencode/plugin";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  type OmissionStore,
  type Transfer,
  type TransferMessage,
  applyTrim,
  buildCapsuleSummary,
  contentId,
  lookup,
  newStore,
  planTrim,
  retrievalAnswer,
  advanceGeneration,
} from "./index";
import { rewriteSession, type SessionApi } from "./transport";

const STATE_DIR = join(homedir(), ".local/state/arkive-v2");
const BACKUP_DIR = join(STATE_DIR, "backups");
const DEAD_LETTER = join(STATE_DIR, "dead-letter.log");
const LOG = join(STATE_DIR, "arkive.log");
const ensureDir = () => mkdirSync(BACKUP_DIR, { recursive: true });
const log = (s: string) => {
  try {
    ensureDir();
    appendFileSync(LOG, `[${new Date().toISOString()}] ${s}\n`);
  } catch {
    /* диск недоступен — последняя инстанция молчания */
  }
};

const FLASH = { providerID: "zai-coding-plan", id: "glm-5.3-flash" };
const TRIM_KEEP_TURNS = 4; // ходы, не трогаемые тримом (дословно в сессии)
const MAX_CAPSULES = 40; // ревью High#5: ограничить число flash-вызовов за хук
const HOOK_DEADLINE_MS = 20 * 60_000; // ревью High#5: общий дедлайн хука → fallback натив
const BACKUP_KEEP = 3; // ревью Common: retention бэкапов = 3 (ротация)
const MAX_STORED_SESSIONS = 50; // cap omission-store: неактивные сессии вытесняются

// —— omission-стора: per-session (ревью Common#3), persist на диск ———
type PersistedStore = {
  sessions: Record<string, { generation: number; entries: unknown[] }>;
};
const loadPersisted = (): PersistedStore => {
  try {
    return JSON.parse(
      readFileSync(join(BACKUP_DIR, "omission-store.json"), "utf8"),
    ) as PersistedStore;
  } catch {
    return { sessions: {} };
  }
};
const persisted = loadPersisted();
const stores = new Map<string, OmissionStore>();
const storeFor = (sid: string): OmissionStore => {
  let s = stores.get(sid);
  if (!s) {
    const rec = persisted.sessions[sid];
    s = newStore(rec?.generation ?? 1);
    for (const e of (rec?.entries ?? []) as never[])
      s.entries.set((e as { contentID: string }).contentID, e);
    stores.set(sid, s);
  }
  return s;
};
/** write-ahead: запись буфера на диск ДО rewrite (коммит после успешного import). */
const persistStore = (sid: string, commit: boolean) => {
  const s = stores.get(sid);
  if (!s) return;
  if (commit)
    persisted.sessions[sid] = {
      generation: s.generation,
      entries: [...s.entries.values()],
    };
  else {
    // preview: включаем записи без продвижения генерации — лишние безвредны
    const rec = persisted.sessions[sid] ?? {
      generation: s.generation,
      entries: [],
    };
    persisted.sessions[sid] = {
      generation: rec.generation,
      entries: (() => {
        const merged = new Map<string, unknown>();
        for (const e of (rec.entries as unknown[]) ?? []) {
          merged.set((e as { contentID: string }).contentID, e);
        }
        for (const [k, v] of s.entries) merged.set(k, v);
        return [...merged.values()];
      })(),
    };
  }
  // рост ограничен: неактивные сессии вытесняются сверх MAX_STORED_SESSIONS
  const keys = Object.keys(persisted.sessions);
  for (const k of keys.slice(
    0,
    Math.max(0, keys.length - MAX_STORED_SESSIONS),
  )) {
    delete persisted.sessions[k];
    stores.delete(k);
  }
  ensureDir();
  writeFileSync(
    join(BACKUP_DIR, "omission-store.json"),
    JSON.stringify(persisted),
  );
};
const persistBackup = (sessionID: string, transfer: unknown) => {
  ensureDir();
  // ротация {sid}.1..3 (ревью: retention 3)
  for (let i = BACKUP_KEEP - 1; i >= 1; i--) {
    const from = join(BACKUP_DIR, `${sessionID}.${i}.json`);
    if (existsSync(from))
      renameSync(from, join(BACKUP_DIR, `${sessionID}.${i + 1}.json`));
  }
  writeFileSync(
    join(BACKUP_DIR, `${sessionID}.1.json`),
    JSON.stringify(transfer),
  );
};
const deadLetter = (texts: string[], error: string) => {
  try {
    ensureDir();
    appendFileSync(
      DEAD_LETTER,
      `[${new Date().toISOString()}] ${error}\n${texts.map(t => `  ПРОМПТ: ${t}`).join("\n")}\n`,
    );
  } catch {
    /* ничего уже не сделать */
  }
};

// —— REST-доступ: ленивая инициализация (отказ роняет только trim-команду, не плагин) ——
let svcCache: { base: string; auth: string } | null = null;
const svc = () => {
  if (!svcCache) {
    const raw = JSON.parse(
      readFileSync(
        join(homedir(), ".local/state/opencode/service.json"),
        "utf8",
      ),
    ) as {
      url: string;
      password: string;
    };
    svcCache = {
      base: String(raw.url).replace("0.0.0.0", "127.0.0.1") + "/api",
      auth:
        "Basic " + Buffer.from(`opencode:${raw.password}`).toString("base64"),
    };
  }
  return svcCache;
};
const restSessionApi = (): SessionApi => ({
  exportTransfer: async sid => {
    const r = await fetch(`${svc().base}/experimental/session/${sid}/export`, {
      headers: { authorization: svc().auth },
    });
    if (!r.ok) throw new Error(`export ${sid}: ${r.status}`);
    return ((await r.json()) as { data: Transfer }).data;
  },
  importTransfer: async body => {
    const r = await fetch(`${svc().base}/experimental/session/import`, {
      method: "POST",
      headers: {
        authorization: svc().auth,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let id: string | undefined;
    try {
      id = (JSON.parse(text) as { data?: { id?: string } }).data?.id;
    } catch {
      /* не json */
    }
    return { status: r.status, id, text };
  },
  remove: async sid =>
    (
      await fetch(`${svc().base}/session/${sid}`, {
        method: "DELETE",
        headers: { authorization: svc().auth },
      })
    ).status,
  inbox: async sid => {
    const r = await fetch(`${svc().base}/session/${sid}/inbox`, {
      headers: { authorization: svc().auth },
    });
    const items =
      (
        (await r.json()) as {
          data?: Array<{
            id: string;
            payload?: { text?: string };
            text?: string;
          }>;
        }
      ).data ?? [];
    return items.map(i => ({
      id: i.id,
      text: i.payload?.text ?? i.text ?? "",
    }));
  },
  cancelInboxItem: async (sid, iid) =>
    (
      await fetch(`${svc().base}/session/${sid}/inbox/${iid}`, {
        method: "DELETE",
        headers: { authorization: svc().auth },
      })
    ).status,
  prompt: async (sid, text) =>
    (
      await fetch(`${svc().base}/session/${sid}/prompt`, {
        method: "POST",
        headers: {
          authorization: svc().auth,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text }),
      })
    ).status,
  listSessions: async () => {
    const r = await fetch(`${svc().base}/session`, {
      headers: { authorization: svc().auth },
    });
    return (
      (
        (await r.json()) as {
          data?: Array<{ id: string; parentID?: string | null }>;
        }
      ).data ?? []
    ).map(s => ({
      id: s.id,
      parentID: s.parentID ?? null,
    }));
  },
});

const parseTurnsArg = (raw: unknown, fallback: number): number => {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// семафоры per-session (trim)
const locks = new Set<string>();

export default Plugin.define({
  id: "arkive-v2",
  async setup(ctx) {
    log(`arkive-v2 loaded (app ${ctx.app.version}, ${ctx.location.directory})`);

    // ——— путь А: капсульный компакшн ———
    type CompactionEvent = {
      sessionID: string;
      messages: readonly unknown[];
      result?: { summary: string };
    };
    try {
      await ctx.session.hook("compaction", async (rawEvent: unknown) => {
        const event = rawEvent as CompactionEvent;
        const t0 = Date.now();
        // event.messages — уже без серверного recent-хвоста: капсулируем ЦЕЛИКОМ
        const msgs = event.messages as TransferMessage[];
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const built = await Promise.race([
            buildCapsuleSummary(
              msgs,
              0,
              async (prompt: string) => {
                const out = await ctx.generate.text({ model: FLASH, prompt });
                const obj = out as unknown as { text?: string };
                return String(obj?.text ?? out ?? "").trim();
              },
              MAX_CAPSULES,
            ),
            new Promise<never>((_, reject) => {
              deadlineTimer = setTimeout(
                () => reject(new Error("hook deadline")),
                HOOK_DEADLINE_MS,
              );
            }),
          ]);
          event.result = { summary: built.summary };
          log(
            `compaction hook: ${built.capsuleCount} капсул за ${Date.now() - t0}ms`,
          );
        } catch (e) {
          // отказ капсул НЕ ломает нативный компакшн: fallback на нативный саммари
          log(
            `compaction hook: капсулы упали (${String(e).slice(0, 120)}) — нативный саммари`,
          );
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
        }
      });
      log("compaction hook зарегистрирован");
    } catch (e) {
      log(`hook-регистрация упала: ${String(e).slice(0, 160)}`);
    }

    // ——— read_omitted_content ———
    try {
      await ctx.tool.transform(editor => {
        editor.add({
          name: "read_omitted_content",
          description:
            "Достать содержимое, вырезанное при trim-компакшне, по Content-ID из omission-нотиса",
          input: {
            type: "object",
            properties: {
              content_id: {
                type: "string",
                description: "Content-ID из нотиса [Content ID: ...]",
              },
            },
            required: ["content_id"],
            additionalProperties: false,
          },
          execute: async (raw, context) => {
            const input = raw as { content_id: string };
            // sessionID — из ToolContext (в input его нет: additionalProperties false)
            const sid = (context as { sessionID?: string } | undefined)
              ?.sessionID;
            // порядок: своя сессия → все материализованные из persisted (переживает рестарты);
            // hit/miss — строго lookup().found, без парсинга текста ответа
            const keys = [
              sid,
              ...Object.keys(persisted.sessions).filter(k => k !== sid),
            ];
            for (const key of keys) {
              if (!key) continue;
              const s = storeFor(key); // ленивая материализация из omission-store.json
              if (lookup(s, input.content_id).found) {
                return { content: retrievalAnswer(s, input.content_id) };
              }
            }
            return {
              content: `Content-ID ${input.content_id} не найден (опечатка, либо вытеснен retention). Восстанови источник повторным вызовом исходного тула.`,
            };
          },
        });
      });
      log("tool read_omitted_content зарегистрирован");
    } catch (e) {
      log(`tool-регистрация упала: ${String(e).slice(0, 160)}`);
    }

    // ——— команды ([N] из текста-аргумента — ревью Low) ———
    try {
      await ctx.command.transform(editor => {
        editor.add({
          name: "arkive-compact",
          description:
            "Капсульный компакшн сессии (нативный механизм, hook Arkive)",
          execute: async ({ sessionID }: { sessionID: string }) => {
            await ctx.session.compact({ sessionID });
          },
        });
        editor.add({
          name: "arkive-trim",
          description:
            "Физическая чистка тул-I/O старых ходов (roundtrip; сохраняет sessionID). /arkive-trim [N]",
          execute: async ({
            sessionID,
            prompt,
          }: {
            sessionID: string;
            prompt?: { text?: string };
          }) => {
            if (locks.has(sessionID)) return;
            locks.add(sessionID);
            try {
              const keep = parseTurnsArg(prompt?.text, TRIM_KEEP_TURNS);
              const store = storeFor(sessionID);
              const api = restSessionApi();
              const result = await rewriteSession(
                api,
                sessionID,
                ctx.location.directory,
                transfer => {
                  const plans = planTrim(transfer.messages, keep, {
                    contentIdFor: contentId,
                  });
                  const { messages } = applyTrim(transfer, plans, store);
                  return messages;
                },
                log,
                {
                  // write-ahead: omission-буфер на диск ДО remove
                  onOmissionsReady: () => persistStore(sessionID, false),
                  onDeadLetter: (texts, error) =>
                    deadLetter(texts, `${sessionID}: ${error}`),
                },
              );
              advanceGeneration(store);
              persistStore(sessionID, true);
              persistBackup(sessionID, result.backup);
              log(
                `trim ${sessionID}: готово (keep=${keep}), бэкап-ротация x${BACKUP_KEEP}`,
              );
            } catch (e) {
              log(`trim ${sessionID}: ОТКАЗ — ${String(e).slice(0, 200)}`);
            } finally {
              locks.delete(sessionID);
            }
          },
        });
        editor.add({
          name: "arkive-stats",
          description: "Статистика Arkive: omission-кэш, бэкапы",
          execute: async ({ sessionID }: { sessionID: string }) => {
            const store = stores.get(sessionID);
            ensureDir();
            const backups = readdirSync(BACKUP_DIR, { withFileTypes: true })
              .filter(
                d =>
                  d.name === `${sessionID}.1.json`
                  || d.name === `${sessionID}.2.json`
                  || d.name === `${sessionID}.3.json`,
              )
              .map(d => d.name);
            await ctx.session.synthetic({
              sessionID,
              text: `Arkive: omission-кэш сессии ${store?.entries.size ?? 0} записей (генерация ${store?.generation ?? "—"}). Бэкапы: ${backups.join(", ") || "—"}. Лог: ${LOG}`,
            });
          },
        });
      });
      log("команды arkive-compact/trim/stats зарегистрированы");
    } catch (e) {
      log(`command-регистрация упала: ${String(e).slice(0, 160)}`);
    }
  },
});
