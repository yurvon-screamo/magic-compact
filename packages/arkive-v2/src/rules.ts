// Pruning-правила (срез 2, ревью v2): адаптация V1-правил Arkive на V2-union.
// Семантика ревью: вырезанное ВСЕГДА retrievable (V1 кладёт read-выводы и полные
// команды в omission-кэш; edit считается по oldString+newString вместе).
import {
  type ToolPart,
  type TransferMessage,
  isToolPart,
  toolOutputText,
  toolInputText,
  overLimit,
} from "./union";

// Пороги V1 (docs/Core.md), без изменений
export const DEFAULT_LIMIT = { words: 128, chars: 1024 };
export const TASK_OUTPUT_LIMIT = { words: 512, chars: 4096 };
const SHELL_CMD_TRUNCATE = 1024;
const SHELL_CMD_KEEP = 512;

export type ToolDecision =
  | { kind: "keep" }
  | { kind: "replace-output"; notice: string; cacheContent?: string }
  | { kind: "replace-input"; notice: string; cacheContent?: string }
  | { kind: "truncate-input"; kept: string; cacheContent?: string };

export type RuleCtx = { contentIdFor: (content: string) => string };

/** Объём edit/write-правки: oldString + newString (+content) вместе (как V1). */
const editVolumeOf = (p: ToolPart): string => {
  const i = p.state?.input as Record<string, unknown> | undefined;
  if (!i) return "";
  return [i.oldString, i.newString, i.content]
    .filter((x): x is string => typeof x === "string")
    .join("\n");
};

/** Правила по имени тула (V2-имена). */
export const decideToolPart = (p: ToolPart, ctx: RuleCtx): ToolDecision => {
  const name = p.name;
  const out = toolOutputText(p);
  const input = toolInputText(p);

  switch (name) {
    case "read":
    case "grep":
    case "glob": {
      // V1 кладёт read-вывод в кэш с Content-ID: исторический снапшот невосстановим
      // перечитыванием (источник мог измениться) — retrievable, как у V1
      if (out && overLimit(out, DEFAULT_LIMIT)) {
        const id = ctx.contentIdFor(out);
        return {
          kind: "replace-output",
          notice: `[Исторический вывод опущён; Content ID: ${id}. Достань точный снапшот через read_omitted_content, либо перечитай источник для текущего состояния.]`,
          cacheContent: out,
        };
      }
      return { kind: "keep" };
    }

    case "write":
    case "edit": {
      const editVolume = editVolumeOf(p);
      if (editVolume && overLimit(editVolume, DEFAULT_LIMIT)) {
        const id = ctx.contentIdFor(editVolume);
        return {
          kind: "replace-input",
          notice: `[Содержимое правки опущено; Content ID: ${id}. Достань через read_omitted_content или перечитай файл.]`,
          cacheContent: editVolume,
        };
      }
      return { kind: "keep" };
    }

    case "shell":
    case "bash": {
      if (input.length > SHELL_CMD_TRUNCATE) {
        // полную команду — в кэш (V1): хвост не теряется
        return {
          kind: "truncate-input",
          kept: `${input.slice(0, SHELL_CMD_KEEP)}\n[REST OF COMMAND TRUNCATED; Content ID: ${ctx.contentIdFor(input)} — полный текст через read_omitted_content]`,
          cacheContent: input,
        };
      }
      if (out && overLimit(out, DEFAULT_LIMIT)) {
        const id = ctx.contentIdFor(out);
        return {
          kind: "replace-output",
          notice: `[Вывод команды опущён; Content ID: ${id}. Достань через read_omitted_content.]`,
          cacheContent: out,
        };
      }
      return { kind: "keep" };
    }

    case "subagent":
    case "task": {
      if (out && overLimit(out, TASK_OUTPUT_LIMIT)) {
        const id = ctx.contentIdFor(out);
        return {
          kind: "replace-output",
          notice: `[Вывод субагента опущён; Content ID: ${id}. Достань через read_omitted_content.]`,
          cacheContent: out,
        };
      }
      return { kind: "keep" };
    }

    case "skill": {
      // скилл перезапускаем — вывод не кэшируем (V1: reloadable by re-invocation)
      if (out && overLimit(out, DEFAULT_LIMIT)) {
        return {
          kind: "replace-output",
          notice:
            "[Вывод скилла опущён (перезапускаем). Вызови скилл заново при необходимости.]",
        };
      }
      return { kind: "keep" };
    }

    default: {
      // webfetch/websearch/прочие: вывод → кэш при превышении
      if (out && overLimit(out, DEFAULT_LIMIT)) {
        const id = ctx.contentIdFor(out);
        return {
          kind: "replace-output",
          notice: `[Вывод ${name} опущён; Content ID: ${id}. Достань через read_omitted_content.]`,
          cacheContent: out,
        };
      }
      return { kind: "keep" };
    }
  }
};

export type TurnPlan = {
  assistantIDs: string[];
  toolDecisions: Map<string, ToolDecision>; // part.id → решение
};

/** Ход (turn) = user-сообщение + следующие assistant-сообщения до следующего user. */
export const splitTurns = (
  msgs: TransferMessage[],
): { user: TransferMessage | null; assistants: TransferMessage[] }[] => {
  const turns: {
    user: TransferMessage | null;
    assistants: TransferMessage[];
  }[] = [];
  for (const m of msgs) {
    if (m.type === "user") turns.push({ user: m, assistants: [] });
    else if (m.type === "assistant") {
      const last = turns[turns.length - 1];
      if (!last) {
        turns.push({ user: null, assistants: [m] });
        continue;
      }
      last.assistants.push(m);
    }
    // idle/system/synthetic/compaction — вне ходов
  }
  return turns;
};

/** План трима: последние keepTurns ходов не трогаем, старше — решаем по правилам. */
export const planTrim = (
  msgs: TransferMessage[],
  keepTurns: number,
  ctx: RuleCtx,
): TurnPlan[] => {
  const turns = splitTurns(msgs);
  const fromTrim = Math.max(0, turns.length - keepTurns);
  return turns.map((t, i) => {
    const toolDecisions = new Map<string, ToolDecision>();
    if (i < fromTrim) {
      for (const a of t.assistants) {
        for (const p of a.content ?? []) {
          if (isToolPart(p)) toolDecisions.set(p.id, decideToolPart(p, ctx));
        }
      }
    }
    return { assistantIDs: t.assistants.map(a => a.id), toolDecisions };
  });
};
