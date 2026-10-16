// Срез 3 (PLAN.md): капсульный суммаризатор.
// Философия Arkive («exact capsules», docs/Core.md): не генеративная вода,
// а ТОЧНЫЕ выжимки хода — файлы, команды, решения, цифры.
// Чистые функции; генерация инжектится (flash через ctx.generate.text).

import {
  type ToolPart,
  type TransferMessage,
  assistantText,
  toolOutputText,
  toolInputText,
  hasTools,
} from "./union";
import { splitTurns } from "./rules";

export type GenerateFn = (prompt: string) => Promise<string>;

/** Порог окупаемости (retention-упрощение V1 profitability): ход меньше этого
 *  объёма капсулировать нечего — одна строка «что было». */
export const CAPSULE_MIN_CHARS = 600;

export const capsulePrompt = (turn: {
  user: TransferMessage | null;
  assistants: TransferMessage[];
}): string => {
  const q = (turn.user?.text ?? "").slice(0, 500);
  const parts: string[] = [];
  for (const a of turn.assistants) {
    const text = assistantText(a);
    if (text) parts.push(`ОТВЕТ: ${text.slice(0, 1500)}`);
    for (const p of a.content ?? []) {
      if (p.type !== "tool") continue;
      const tp = p as ToolPart;
      parts.push(
        `ТУЛ ${tp.name}: вход=${toolInputText(tp).slice(0, 300)} вывод=${toolOutputText(tp).slice(0, 600)}`,
      );
    }
  }
  return [
    "Сожми один ход агентской сессии в КАПСУЛУ — точную выжимку без интерпретаций.",
    "Формат: 1–3 строки. Обязательно сохрани: имена файлов, команды, пути, цифры, решения («сделал X, потому что Y»).",
    "Не добавляй ничего от себя. Не пересказывай общими словами. Если были ошибки — назови их точно.",
    "",
    `ЗАПРОС ПОЛЬЗОВАТЕЛЯ: ${q}`,
    ...parts.map(p => p),
  ].join("\n");
};

export type Capsule = { turnIndex: number; text: string };

export type CapsulePlan = {
  /** ходы, достойные полной капсулы (объём выше порога) */
  capsule: { turnIndex: number; prompt: string }[];
  /** мелкие ходы — однострочные упоминания */
  minor: { turnIndex: number; line: string }[];
};

export const planCapsules = (
  messages: TransferMessage[],
  keepTurns: number,
): CapsulePlan => {
  const turns = splitTurns(messages);
  const fromCapsule = Math.max(0, turns.length - keepTurns);
  const capsule: CapsulePlan["capsule"] = [];
  const minor: CapsulePlan["minor"] = [];
  turns.forEach((t, i) => {
    if (i >= fromCapsule) return;
    const volume =
      (t.user?.text ?? "").length
      + t.assistants.reduce(
        (n, a) =>
          n
          + assistantText(a).length
          + (a.content ?? []).reduce(
            (m, p) =>
              m
              + (p.type === "tool"
                ? toolOutputText(p as ToolPart).length
                  + toolInputText(p as ToolPart).length
                : 0),
            0,
          ),
        0,
      );
    if (volume >= CAPSULE_MIN_CHARS || t.assistants.some(a => hasTools(a))) {
      capsule.push({ turnIndex: i, prompt: capsulePrompt(t) });
    } else {
      minor.push({
        turnIndex: i,
        line: `· ${(t.user?.text ?? "(без текста)").slice(0, 80)}`,
      });
    }
  });
  return { capsule, minor };
};

/** Сборка итогового summary compaction-сообщения из капсул и мелочи. */
export const assembleSummary = (
  capsules: Capsule[],
  minorLines: string[],
  keepTurns: number,
): string => {
  const blocks = capsules.map(c => c.text.trim()).filter(Boolean);
  const head = ["## Капсульная история (точные выжимки ходов)", "", ...blocks];
  if (minorLines.length) head.push("", "## Мелкие ходы", ...minorLines);
  head.push(
    "",
    `## Свежие ${keepTurns} ход(ов) следуют ниже дословно (recent)`,
  );
  return head.join("\n");
};

/** Полный прогон: план → генерация капсул → summary. Бросает при отказе генерации. */
export const buildCapsuleSummary = async (
  messages: TransferMessage[],
  keepTurns: number,
  generate: GenerateFn,
): Promise<{ summary: string; capsuleCount: number }> => {
  const plan = planCapsules(messages, keepTurns);
  const capsules: Capsule[] = [];
  for (const c of plan.capsule) {
    const text = await generate(c.prompt);
    capsules.push({ turnIndex: c.turnIndex, text });
  }
  return {
    summary: assembleSummary(
      capsules,
      plan.minor.map(m => m.line),
      keepTurns,
    ),
    capsuleCount: capsules.length,
  };
};
