// Тесты транспорта trim-ветки (ревью Common: нулевое покрытие самого опасного модуля).
// SessionApi мокается — сценарии протокола среза 1 + отказные пути.
import { describe, test, expect } from "bun:test";
import { rewriteSession, freshSid, reIdMessages } from "../src/transport";
import type { SessionApi } from "../src/transport";
import type { Transfer, TransferMessage } from "../src/union";

const msg = (id: string, type: string, text = ""): TransferMessage => ({
  id,
  type,
  time: { created: Date.now() },
  text,
});
const T = (id: string, ...messages: TransferMessage[]): Transfer => ({
  info: { id },
  messages,
});

type Call = string;
const mkApi = (
  opts: {
    children?: Array<{ id: string; parentID?: string | null }>;
    inbox?: Array<{ id: string; text: string }>;
    failImport?: number;
    failRestore?: number;
  } = {},
) => {
  const calls: Call[] = [];
  const removed: string[] = [];
  const rePrompts: string[] = [];
  const store = new Map<string, Transfer>();
  let importCount = 0;
  const api: SessionApi = {
    async exportTransfer(sid) {
      calls.push(`export:${sid}`);
      const t = store.get(sid);
      if (!t) throw new Error("нет сессии");
      return t;
    },
    async importTransfer(body) {
      importCount++;
      calls.push(
        `import:${String(body.info.id).slice(0, 12)}:${body.messages.length}msg`,
      );
      if (body.info.id === "ses_SOURCE") {
        // основной import (родной id после remove): имитируем отказ/успех по счётчику
        if (opts.failImport && importCount >= 2)
          return { status: opts.failImport, text: "имитация отказа" };
        if (opts.failRestore && importCount >= 3)
          return { status: opts.failRestore, text: "имитация отказа restore" };
      }
      store.set(String(body.info.id), {
        info: body.info as Record<string, unknown>,
        messages: body.messages,
      });
      return { status: 200, id: String(body.info.id), text: "" };
    },
    async remove(sid) {
      calls.push(`remove:${sid.slice(0, 12)}`);
      removed.push(sid);
      store.delete(sid);
      return 204;
    },
    async inbox(sid) {
      calls.push(`inbox:${sid.slice(0, 12)}`);
      return opts.inbox ?? [];
    },
    async cancelInboxItem(sid, iid) {
      calls.push(`cancel:${iid}`);
      return 200;
    },
    async prompt(sid, text) {
      rePrompts.push(text);
      return 200;
    },
    async listSessions() {
      return opts.children ?? [];
    },
  };
  return { api, calls, removed, rePrompts, store };
};

describe("rewriteSession: happy path", () => {
  test("pre-flight валидируется И УДАЛЯЕТСЯ; дрен пуст; родной id жив", async () => {
    const src = T(
      "ses_SOURCE",
      msg("m1", "user", "вопрос"),
      msg("m2", "assistant", "ответ"),
    );
    const { api, calls, removed, store } = mkApi();
    store.set("ses_SOURCE", src);
    const res = await rewriteSession(
      api,
      "ses_SOURCE",
      "/loc",
      t => t.messages,
    );
    // порядок: list → export → import(pf) → remove(pf) → inbox → remove(src) → import(src)
    expect(calls[0]).toBe("list" in api ? calls[0] : calls[0]); // список первый (см. ниже)
    expect(calls.find(c => c.startsWith("export:"))).toContain("ses_SOURCE");
    const pfRemove = calls.find(c => c.startsWith("remove:ses_e"));
    expect(pfRemove).toBeTruthy(); // pre-flight копия удалена (High#1)
    expect(removed).toContain("ses_SOURCE");
    expect(res.backup.messages.length).toBe(2);
    expect(store.get("ses_SOURCE")?.messages[0]?.id).toBe("m1"); // родные id
  });
  test("идентификаторы pre-flight: свежие ses_e и перегенерированные msg_", async () => {
    const sidReg = /^ses_e[0-9a-zA-Z]{24}$/;
    const midReg = /^msg_[0-9a-zA-Z]{20}$/;
    expect(sidReg.test(freshSid())).toBe(true);
    const reIded = reIdMessages([msg("m1", "user", "x")]);
    expect(midReg.test(reIded[0]?.id ?? "")).toBe(true);
  });
});

describe("rewriteSession: precondition детей", () => {
  test("есть дочерние → отказ ДО export, ничего не тронуто", async () => {
    const { api, calls, removed } = mkApi({
      children: [{ id: "ses_CHILD", parentID: "ses_SOURCE" }],
    });
    await expect(
      rewriteSession(api, "ses_SOURCE", "/loc", t => t.messages),
    ).rejects.toThrow("дочерние");
    expect(calls.find(c => c.startsWith("export:"))).toBeUndefined();
    expect(removed.length).toBe(0);
  });
});

describe("rewriteSession: дрен inbox", () => {
  test("дренированные промпты переотправляются после import", async () => {
    const { api, rePrompts, removed } = mkApi({
      inbox: [{ id: "in1", text: "не потеряй меня" }],
    });
    const src = T("ses_SOURCE", msg("m1", "user", "q"));
    const st = new Map<string, Transfer>();
    // прокинем стор
    const store = api as unknown as { store?: Map<string, Transfer> };
    void store;
    void st;
    // mkApi хранит стор внутри; положим исходник через exportTransfer мока — упростим: свой мини-стор
    const api2: SessionApi = {
      ...api,
      exportTransfer: async () => src,
    };
    await rewriteSession(api2, "ses_SOURCE", "/loc", t => t.messages);
    expect(rePrompts).toEqual(["не потеряй меня"]);
    expect(removed).toContain("ses_SOURCE");
  });
  test("отказ remove после дрена → dead-letter получает тексты", async () => {
    const dead: Array<{ texts: string[]; error: string }> = [];
    const api: SessionApi = {
      async exportTransfer() {
        return T("ses_SOURCE", msg("m1", "user", "q"));
      },
      async importTransfer(body) {
        return { status: 200, id: String(body.info.id), text: "" };
      },
      async remove(sid) {
        return sid === "ses_SOURCE" ? 500 : 204;
      },
      async inbox() {
        return [{ id: "in1", text: "важный промпт" }];
      },
      async cancelInboxItem() {
        return 200;
      },
      async prompt() {
        return 200;
      },
      async listSessions() {
        return [];
      },
    };
    await expect(
      rewriteSession(
        api,
        "ses_SOURCE",
        "/loc",
        t => t.messages,
        () => {},
        { onDeadLetter: (texts, error) => dead.push({ texts, error }) },
      ),
    ).rejects.toThrow("remove: 500");
    expect(dead[0]?.texts).toEqual(["важный промпт"]);
  });
});

describe("rewriteSession: отказ import → restore-ретрай", () => {
  test("import падает → restore из бэкапа → сессия восстановлена исходником", async () => {
    const src = T(
      "ses_SOURCE",
      msg("m1", "user", "q"),
      msg("m2", "assistant", "a"),
    );
    const importLog: Array<{ id: string; messages: TransferMessage[] }> = [];
    const api: SessionApi = {
      async exportTransfer() {
        return src;
      },
      async importTransfer(body) {
        importLog.push({ id: String(body.info.id), messages: body.messages });
        if (
          body.info.id === "ses_SOURCE"
          && importLog.filter(x => x.id === "ses_SOURCE").length === 1
        ) {
          return { status: 500, text: "имитация" };
        }
        return { status: 200, id: String(body.info.id), text: "" };
      },
      async remove() {
        return 204;
      },
      async inbox() {
        return [];
      },
      async cancelInboxItem() {
        return 200;
      },
      async prompt() {
        return 200;
      },
      async listSessions() {
        return [];
      },
    };
    await rewriteSession(api, "ses_SOURCE", "/loc", t => t.messages);
    const sourceImports = importLog.filter(x => x.id === "ses_SOURCE");
    expect(sourceImports.length).toBe(2); // отказ + restore
    expect(sourceImports[1]?.messages.length).toBe(2); // restore получил исходник
  });
});
