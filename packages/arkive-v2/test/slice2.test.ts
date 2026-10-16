// Срез 2 (PLAN.md): юнит-тесты правил/кэша/transform.
// Фикстуры: живой export с tool-ходом (test/fixtures/tool-turn.json) + синтетика union.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ToolPart,
  type TransferMessage,
  type Transfer,
  assistantText,
  toolOutputText,
  toolInputText,
  newStore,
  put,
  lookup,
  retrievalAnswer,
  advanceGeneration,
  contentId,
  decideToolPart,
  planTrim,
  splitTurns,
  applyTrim,
  DEFAULT_LIMIT,
} from "../src/index";

const fixture: Transfer = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "tool-turn.json"), "utf8"),
);
const ctx = { contentIdFor: contentId };

const msg = (
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
): TransferMessage =>
  ({
    id,
    type,
    time: { created: Date.now() },
    ...extra,
  }) as TransferMessage;
const toolPart = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  output: string,
): ToolPart => ({
  type: "tool",
  id,
  name,
  executed: true,
  state: {
    status: "completed",
    input,
    content: [{ type: "text", text: output }],
  },
});

describe("union: V2-export структура (живая фикстура)", () => {
  test("assistant-текст достаётся из content[], не из m.text", () => {
    const withText = fixture.messages.find(
      m =>
        m.type === "assistant"
        && (m.content ?? []).some(p => p.type === "text"),
    );
    expect(withText).toBeDefined();
    expect(assistantText(withText!)).toContain("ARKIVE_FIXTURE");
  });
  test("tool-вывод достаётся из state.content", () => {
    const tp = fixture.messages
      .flatMap(m => m.content ?? [])
      .find(p => p.type === "tool") as ToolPart;
    expect(toolOutputText(tp)).toContain("ARKIVE_FIXTURE");
    expect(toolOutputText(tp)).toContain("probe.png");
  });
  test("tool-вход shell достаётся (command)", () => {
    const tp = fixture.messages
      .flatMap(m => m.content ?? [])
      .find(p => p.type === "tool") as ToolPart;
    expect(toolInputText(tp)).toContain("echo");
  });
  test("files-поле не трогается трансформом (инвариант ниже)", () => {
    const withFiles = msg("u1", "user", {
      text: "вот файл",
      files: [{ data: "iVBOR..." }],
    });
    const { messages } = applyTrim(
      { info: {}, messages: [withFiles] },
      [],
      newStore(),
    );
    expect(
      (messages[0] as TransferMessage & { files?: unknown[] }).files,
    ).toEqual([{ data: "iVBOR..." }]);
  });
});

describe("omission-кэш", () => {
  test("put/lookup/retrievalAnswer", () => {
    const s = newStore();
    const id = put(s, "shell", "большой вывод");
    expect(lookup(s, id)).toEqual({
      found: true,
      entry: expect.objectContaining({ contentID: id, toolName: "shell" }),
    });
    expect(retrievalAnswer(s, id)).toBe("большой вывод");
  });
  test("miss: определённое «не найдено», не падение", () => {
    const s = newStore();
    const a = retrievalAnswer(s, "nosuchid");
    expect(a).toContain("не найден");
    put(s, "shell", "x");
    const b = retrievalAnswer(s, "nosuchid2");
    expect(b).toContain("вытеснено");
  });
  test("retention: последние 2 поколения, старше вытесняются", () => {
    const s = newStore(1);
    const g1 = put(s, "shell", "gen1");
    advanceGeneration(s); // → 2
    const g2 = put(s, "shell", "gen2");
    advanceGeneration(s); // → 3
    const g3 = put(s, "shell", "gen3");
    expect(lookup(s, g1).found).toBe(false); // поколение 1 < 2
    expect(lookup(s, g2).found).toBe(true);
    expect(lookup(s, g3).found).toBe(true);
  });
  test("Content-ID стабилен по содержимому (переживает rewrite)", () => {
    expect(contentId("одинаково")).toBe(contentId("одинаково"));
    expect(contentId("а")).not.toBe(contentId("б"));
  });
});

describe("rules: адаптация V1-правил", () => {
  const big = "x".repeat(DEFAULT_LIMIT.chars + 1);
  const small = "ок";

  test("shell: мелкий вывод — keep", () => {
    expect(
      decideToolPart(toolPart("t1", "shell", { command: "ls" }, small), ctx)
        .kind,
    ).toBe("keep");
  });
  test("shell: большой вывод → replace-output + кэш", () => {
    const d = decideToolPart(
      toolPart("t2", "shell", { command: "ls" }, big),
      ctx,
    );
    expect(d.kind).toBe("replace-output");
    if (d.kind === "replace-output") {
      expect(d.cacheContent).toBe(big);
      expect(d.notice).toContain("Content ID");
    }
  });
  test("shell: команда >1024 → truncate-input", () => {
    const long = "y".repeat(1200);
    const d = decideToolPart(
      toolPart("t3", "shell", { command: long }, small),
      ctx,
    );
    expect(d.kind).toBe("truncate-input");
    if (d.kind === "truncate-input") expect(d.cacheContent).toBe(long);
  });
  test("read: большой вывод → нотис + кэш-снапшот (V1-семантика)", () => {
    const d = decideToolPart(toolPart("t4", "read", { path: "/f" }, big), ctx);
    expect(d.kind).toBe("replace-output");
    if (d.kind === "replace-output") expect(d.cacheContent).toBe(big);
  });
  test("edit: большое содержание → replace-input + кэш", () => {
    const d = decideToolPart(
      toolPart("t5", "edit", { oldString: big, newString: big }, ""),
      ctx,
    );
    expect(d.kind).toBe("replace-input");
    if (d.kind === "replace-input") expect(d.cacheContent).toContain("x");
  });
  test("subagent: лимит выше (4096 chars)", () => {
    const mid = "z".repeat(2000); // > default, < task
    expect(decideToolPart(toolPart("t6", "subagent", {}, mid), ctx).kind).toBe(
      "keep",
    );
    expect(
      decideToolPart(
        toolPart("t7", "subagent", {}, big + big + big + big + big),
        ctx,
      ).kind,
    ).toBe("replace-output");
  });
  test("неизвестный тул → дефолт: кэш при превышении", () => {
    const d = decideToolPart(
      toolPart("t8", "webfetch", { url: "https://x" }, big),
      ctx,
    );
    expect(d.kind).toBe("replace-output");
  });
});

describe("splitTurns / planTrim", () => {
  const msgs = [
    msg("u1", "user", { text: "q1" }),
    msg("a1", "assistant", {
      content: [
        toolPart("p1", "shell", { command: "ls" }, "big-вывод".repeat(200)),
      ],
    }),
    msg("u2", "user", { text: "q2" }),
    msg("a2", "assistant", { content: [{ type: "text", text: "ответ" }] }),
    msg("idle1", "idle"),
  ];
  test("ходы делятся по user", () => {
    const turns = splitTurns(msgs);
    expect(turns.length).toBe(2);
    expect(turns[0]?.user?.id).toBe("u1");
    expect((turns[0] ?? { assistants: [] }).assistants.map(a => a.id)).toEqual([
      "a1",
    ]);
  });
  test("planTrim keepTurns=1: старый ход режется, свежий нет", () => {
    const plans = planTrim(msgs, 1, ctx);
    expect(plans[0]?.toolDecisions.size).toBe(1); // старый ход: решение есть
    expect(plans[1]?.toolDecisions.size).toBe(0); // свежий: нетронут
  });
});

describe("applyTrim: чистая трансформация", () => {
  test("заменяет вывод tool-партов старых ходов, кладёт в кэш, сохраняет порядок и user/files", () => {
    const bigOut = "BIG".repeat(1000);
    const msgs = [
      msg("u1", "user", { text: "q1", files: [{ data: "abc" }] }),
      msg("a1", "assistant", {
        content: [
          { type: "reasoning", text: "думаю" },
          toolPart("p1", "shell", { command: "ls -la" }, bigOut),
        ],
      }),
      msg("u2", "user", { text: "q2" }),
      msg("a2", "assistant", {
        content: [toolPart("p2", "shell", { command: "ls" }, bigOut)],
      }),
    ];
    const store = newStore();
    const plans = planTrim(msgs, 1, ctx);
    const { messages, stats } = applyTrim(
      { info: {}, messages: msgs },
      plans,
      store,
    );

    expect(messages.map(m => m.id)).toEqual(["u1", "a1", "u2", "a2"]); // порядок
    expect(
      (messages[0] as TransferMessage & { files?: unknown[] }).files,
    ).toEqual([{ data: "abc" }]); // files нетронуты
    const a1p = (messages[1]?.content ?? []).find(
      p => p.type === "tool",
    ) as ToolPart;
    const a2p = (messages[3]?.content ?? []).find(
      p => p.type === "tool",
    ) as ToolPart;
    expect(a1p.state?.content?.[0]).toHaveProperty(
      "text",
      expect.stringContaining("Content ID"),
    ); // старый — заменён
    expect(a2p.state?.content?.[0]).toHaveProperty(
      "text",
      expect.stringContaining("BIG"),
    ); // свежий — дословно
    expect(store.entries.size).toBe(1); // только старый в кэше
    expect(stats.replaced).toBe(1);
    expect(stats.bytesCached).toBe(bigOut.length);
    // reasoning-парт не потерялся
    expect((messages[1]?.content ?? []).some(p => p.type === "reasoning")).toBe(
      true,
    );
  });
  test("на живой фикстуре: старый ход (все 4 сообщения = 2 хода? нет — 1 ход) не режется при keep=1", () => {
    const store = newStore();
    const plans = planTrim(fixture.messages, 1, ctx);
    const { messages } = applyTrim(fixture, plans, store);
    expect(messages).toEqual(fixture.messages); // единственный ход свежий — идентично
  });
});
