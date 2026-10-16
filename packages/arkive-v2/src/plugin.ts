// Arkive V2 — плагин OpenCode V2 (срезы 3–4, PLAN.md).
// Путь А (ADR-001): нативный compaction-hook + капсулы через ctx.generate.text.
// Trim-ветка: roundtrip-транспорт (transport.ts) по протоколу среза 1.
import { Plugin } from "@opencode/plugin";
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  type TransferMessage,
  buildCapsuleSummary,
  planCapsules,
  planTrim,
  applyTrim,
  contentId,
  newStore,
  retrievalAnswer,
  advanceGeneration,
  type OmissionStore,
} from "./index";

const BACKUP_DIR = join(homedir(), ".local/state/arkive-v2/backups");
const LOG = join(homedir(), ".local/state/arkive-v2/arkive.log");
const log = (s: string) => {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${s}\n`);
  } catch {
    /* диск недоступен — молча */
  }
};

const FLASH = { providerID: "zai-coding-plan", id: "glm-5.3-flash" };
const KEEP_TURNS = 12; // свежие ходы идут minor-строкой, не капсулой; дословный хвост задаёт compaction.keep.tokens (48k ≈ 15–20 ходов зоопарка)
const TRIM_KEEP_TURNS = 4;

const loadStore = (): OmissionStore => {
  try {
    const raw = JSON.parse(
      readFileSync(join(BACKUP_DIR, "omission-store.json"), "utf8"),
    );
    const s = newStore(raw.generation ?? 1);
    for (const e of raw.entries ?? []) s.entries.set(e.contentID, e);
    return s;
  } catch {
    return newStore(1);
  }
};
const saveStore = (s: OmissionStore) => {
  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(
    join(BACKUP_DIR, "omission-store.json"),
    JSON.stringify({
      generation: s.generation,
      entries: [...s.entries.values()],
    }),
  );
};
const persistBackup = (sessionID: string, transfer: unknown) => {
  mkdirSync(BACKUP_DIR, { recursive: true });
  writeFileSync(
    join(BACKUP_DIR, `${sessionID}.json`),
    JSON.stringify(transfer),
  );
};

// семафоры per-session (trim)
const locks = new Set<string>();

export default Plugin.define({
  id: "arkive-v2",
  async setup(ctx) {
    log(`arkive-v2 loaded (app ${ctx.app.version}, ${ctx.location.directory})`);
    const store = loadStore();

    // ——— путь А: капсульный компакшн ———
    type CompactionEvent = {
      sessionID: string;
      messages: readonly unknown[];
      result?: { summary: string };
    };
    type Transfer = {
      info: Record<string, unknown>;
      messages: TransferMessage[];
    };
    type InboxItem = { id: string; payload?: { text?: string }; text?: string };
    try {
      await ctx.session.hook("compaction", async (event: CompactionEvent) => {
        const t0 = Date.now();
        const msgs = event.messages as TransferMessage[];
        const plan = planCapsules(msgs, KEEP_TURNS);
        log(
          `compaction hook: session=${event.sessionID} ходов к капсулированию=${plan.capsule.length}, мелких=${plan.minor.length}`,
        );
        try {
          const { summary, capsuleCount } = await buildCapsuleSummary(
            msgs,
            KEEP_TURNS,
            async prompt => {
              const out = await ctx.generate.text({ model: FLASH, prompt });
              const obj = out as unknown as { text?: string };
              return String(obj?.text ?? out ?? "").trim();
            },
          );
          event.result = { summary };
          log(
            `compaction hook: ${capsuleCount} капсул за ${Date.now() - t0}ms`,
          );
        } catch (e) {
          // отказ капсул НЕ должен ломать нативный компакшн: отдаём одну строку-заглушку
          log(
            `compaction hook: капсулы упали (${String(e).slice(0, 120)}) — нативный саммари`,
          );
        }
      });

      // ——— read_omitted_content: retrieval из omission-кэша ———
      void ctx.tool.transform(editor => {
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
          execute: async raw => {
            const input = raw as { content_id: string };
            return { content: retrievalAnswer(store, input.content_id) };
          },
        });
      });

      // ——— команды ———
      void ctx.command.transform(editor => {
        editor.add({
          name: "arkive-compact",
          description:
            "Капсульный компакшн сессии (нативный механизм, hook Arkive)",
          execute: async ({ sessionID }: { sessionID: string }) => {
            await ctx.session.compact({ sessionID } as never);
          },
        });
        editor.add({
          name: "arkive-trim",
          description:
            "Физическая чистка тул-I/O старых ходов (roundtrip; сохраняет sessionID)",
          execute: async ({ sessionID }: { sessionID: string }) => {
            if (locks.has(sessionID)) return;
            locks.add(sessionID);
            try {
              const dir = ctx.location.directory;
              // REST-реализация SessionApi поверх клиентского контекста
              const api = {
                exportTransfer: async (sid: string) => {
                  const r = await fetch(
                    restBase() + `/experimental/session/${sid}/export`,
                    { headers: { authorization: restAuth() } },
                  );
                  return ((await r.json()) as { data: Transfer }).data;
                },
                importTransfer: async (body: {
                  info: Record<string, unknown>;
                  messages: TransferMessage[];
                  location?: { directory: string };
                }) => {
                  const r = await fetch(
                    restBase() + "/experimental/session/import",
                    {
                      method: "POST",
                      headers: {
                        authorization: restAuth(),
                        "content-type": "application/json",
                      },
                      body: JSON.stringify(body),
                    },
                  );
                  const text = await r.text();
                  let id: string | undefined;
                  try {
                    id = JSON.parse(text).data?.id;
                  } catch {
                    /* не json */
                  }
                  return { status: r.status, id, text };
                },
                remove: async (sid: string) =>
                  (
                    await fetch(restBase() + `/session/${sid}`, {
                      method: "DELETE",
                      headers: { authorization: restAuth() },
                    })
                  ).status,
                inbox: async (sid: string) => {
                  const r = await fetch(restBase() + `/session/${sid}/inbox`, {
                    headers: { authorization: restAuth() },
                  });
                  const items =
                    ((await r.json()) as { data?: InboxItem[] }).data ?? [];
                  return items.map(i => ({
                    id: i.id,
                    text: i.payload?.text ?? i.text ?? "",
                  }));
                },
                cancelInboxItem: async (sid: string, iid: string) =>
                  (
                    await fetch(restBase() + `/session/${sid}/inbox/${iid}`, {
                      method: "DELETE",
                      headers: { authorization: restAuth() },
                    })
                  ).status,
                prompt: async (sid: string, text: string) =>
                  (
                    await fetch(restBase() + `/session/${sid}/prompt`, {
                      method: "POST",
                      headers: {
                        authorization: restAuth(),
                        "content-type": "application/json",
                      },
                      body: JSON.stringify({ text }),
                    })
                  ).status,
              } as const;

              const { rewriteSession } = await import("./transport");
              const result = await rewriteSession(
                api,
                sessionID,
                dir,
                transfer => {
                  const plans = planTrim(transfer.messages, TRIM_KEEP_TURNS, {
                    contentIdFor: contentId,
                  });
                  // кэш: собрать omission-записи при применении
                  const { messages } = applyTrim(transfer, plans, store);
                  return messages;
                },
                log,
              );
              advanceGeneration(store);
              saveStore(store);
              persistBackup(sessionID, result.backup);
              log(`trim ${sessionID}: готово, бэкап записан`);
            } catch (e) {
              log(`trim ${sessionID}: ОТКАЗ — ${String(e).slice(0, 200)}`);
            } finally {
              locks.delete(sessionID);
            }
          },
        });
        editor.add({
          name: "arkive-stats",
          description: "Статистика Arkive: omission-кэш, генерация",
          execute: async ({ sessionID }: { sessionID: string }) => {
            await ctx.session.synthetic({
              sessionID,
              text: `Arkive: omission-кэш ${store.entries.size} записей (генерация ${store.generation}, хранятся последние 2). Лог: ${LOG}`,
            } as never);
          },
        });
      });
      log("команды arkive-compact/trim/stats зарегистрированы");
    } catch (e) {
      log(`command-регистрация упала: ${String(e).slice(0, 160)}`);
    }
  },
});

// REST-доступ плагина к своему же серверу: registration-файл сервиса
import { readFileSync as _rf } from "node:fs";
const restBase = () => {
  const reg = JSON.parse(
    _rf(join(homedir(), ".local/state/opencode/service.json"), "utf8"),
  );
  return String(reg.url).replace("0.0.0.0", "127.0.0.1") + "/api";
};
const restAuth = () =>
  "Basic "
  + Buffer.from(
    `opencode:${JSON.parse(_rf(join(homedir(), ".local/state/opencode/service.json"), "utf8")).password}`,
  ).toString("base64");
export const _internal = { restBase, restAuth, existsSync };
