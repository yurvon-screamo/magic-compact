// Срез 3: капсульный суммаризатор — юнит (генерация мокается, без сети)
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planCapsules,
  capsulePrompt,
  assembleSummary,
  buildCapsuleSummary,
} from "../src/capsule";
import type { TransferMessage } from "../src/union";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "tool-turn.json"), "utf8"),
);

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
) => ({
  type: "tool",
  id,
  name,
  state: {
    status: "completed",
    input,
    content: [{ type: "text", text: output }],
  },
});

describe("planCapsules", () => {
  test("свежие ходы (keep) не капсулируются", () => {
    const msgs = [
      msg("u1", "user", { text: "старый большой вопрос ".repeat(30) }),
      msg("a1", "assistant", {
        content: [
          toolPart("p1", "shell", { command: "x" }, "вывод".repeat(300)),
        ],
      }),
      msg("u2", "user", { text: "свежий" }),
      msg("a2", "assistant", {
        content: [{ type: "text", text: "свежий ответ" }],
      }),
    ];
    const plan = planCapsules(msgs, 1);
    expect(plan.capsule.length).toBe(1); // только старый ход
    expect(plan.capsule[0].turnIndex).toBe(0);
    expect(plan.minor.length).toBe(0);
  });
  test("мелкий ход без тулов → minor-строка, без flash-вызова", () => {
    const msgs = [
      msg("u1", "user", { text: "привет" }),
      msg("a1", "assistant", { content: [{ type: "text", text: "привет!" }] }),
    ];
    const plan = planCapsules(msgs, 0);
    expect(plan.capsule.length).toBe(0);
    expect(plan.minor.length).toBe(1);
    expect(plan.minor[0].line).toContain("привет");
  });
  test("ход с тулом капсулируется независимо от объёма (факты тулов важнее порога)", () => {
    const msgs = [
      msg("u1", "user", { text: "ls" }),
      msg("a1", "assistant", {
        content: [toolPart("p1", "read", { path: "/f.ts" }, "small")],
      }),
    ];
    const plan = planCapsules(msgs, 0);
    expect(plan.capsule.length).toBe(1);
  });
});

describe("capsulePrompt", () => {
  test("несёт запрос, тулы с входом/выводом, требует точность", () => {
    const p = capsulePrompt({
      user: msg("u1", "user", { text: "почини билд" }),
      assistants: [
        msg("a1", "assistant", {
          content: [
            toolPart(
              "p1",
              "shell",
              { command: "cargo build" },
              "error[E0308] in src/lib.rs:42",
            ),
          ],
        }),
      ] as unknown as TransferMessage[],
    });
    expect(p).toContain("почини билд");
    expect(p).toContain("cargo build");
    expect(p).toContain("E0308");
    expect(p).toContain("без интерпретаций");
  });
});

describe("assembleSummary / buildCapsuleSummary", () => {
  test("структура: капсулы + мелочь + маркер recent", () => {
    const s = assembleSummary(
      [
        {
          turnIndex: 0,
          text: "Сделал X через Y, файл /a/b.rs, ошибка E0308 закрыта",
        },
      ],
      ["· мелкий вопрос"],
      6,
    );
    expect(s).toContain("## Капсульная история");
    expect(s).toContain("E0308");
    expect(s).toContain("## Мелкие ходы");
    expect(s).toContain("дословно");
  });
  test("buildCapsuleSummary: генерация инжектится по одному вызову на капсулу", async () => {
    const calls: string[] = [];
    const { summary, capsuleCount } = await buildCapsuleSummary(
      [
        msg("u1", "user", { text: "большой вопрос ".repeat(100) }),
        msg("a1", "assistant", {
          content: [toolPart("p1", "shell", { command: "x" }, "o".repeat(900))],
        }),
        msg("u2", "user", { text: "ещё большой ".repeat(100) }),
        msg("a2", "assistant", {
          content: [
            toolPart("p2", "edit", { oldString: "y".repeat(900) }, "ok"),
          ],
        }),
        msg("u3", "user", { text: "свежее" }),
      ],
      1,
      async p => {
        calls.push(p);
        return `КАПСУЛА#${calls.length}`;
      },
    );
    expect(calls.length).toBe(2);
    expect(capsuleCount).toBe(2);
    expect(summary).toContain("КАПСУЛА#1");
    expect(summary).toContain("КАПСУЛА#2");
  });
  test("на живой фикстуре: один ход с тулом → одна капсула при keep=0", async () => {
    const { summary, capsuleCount } = await buildCapsuleSummary(
      fixture.messages,
      0,
      async () => "капсула живой сессии",
    );
    expect(capsuleCount).toBe(1);
    expect(summary).toContain("капсула живой сессии");
  });
});
