// Pruning-правила (срез 2): адаптация V1-правил Arkive (packages/opencode-plugin/
// src/compact/prune.ts, пороги docs/Core.md) на V2-union export-массив.
// Чистые функции: вход — сообщения transfer, выход — решения по tool-партам.
import { type ToolPart, type TransferMessage, isToolPart, toolOutputText, toolInputText, overLimit } from "./union"

// Пороги V1 (docs/Core.md), без изменений
export const DEFAULT_LIMIT = { words: 128, chars: 1024 }
export const TASK_OUTPUT_LIMIT = { words: 512, chars: 4096 }
const SHELL_CMD_TRUNCATE = 1024
const SHELL_CMD_KEEP = 512

export type ToolDecision =
  | { kind: "keep" }
  | { kind: "replace-output"; notice: string; cache: boolean } // вывод → нотис; cache=положить в omission-кэш
  | { kind: "replace-input"; notice: string; cache: boolean }
  | { kind: "truncate-input"; kept: string }

export type RuleCtx = { contentIdFor: (content: string) => string }

/** Правила по имени тула (V2-имена: shell/read/grep/glob/edit/write/subagent/skill/webfetch...). */
export const decideToolPart = (p: ToolPart, ctx: RuleCtx): ToolDecision => {
  const name = p.name
  const out = toolOutputText(p)
  const input = toolInputText(p)

  switch (name) {
    case "read":
    case "grep":
    case "glob":
      // перезачитываемо: вывод вон, БЕЗ кэша (V1: «reloadable»)
      if (out && overLimit(out, DEFAULT_LIMIT)) {
        return { kind: "replace-output", notice: "[Исторический вывод опущён (файл/поиск перечитываем). Прочти заново при необходимости.]", cache: false }
      }
      return { kind: "keep" }

    case "write":
    case "edit":
      // содержимое правки → нотис + кэш («reread file»)
      if (input && overLimit(input, DEFAULT_LIMIT)) {
        const id = ctx.contentIdFor(input)
        return { kind: "replace-input", notice: `[Содержимое правки опущено; Content ID: ${id}. Достань через read_omitted_content или перечитай файл.]`, cache: true }
      }
      return { kind: "keep" }

    case "shell":
    case "bash":
      if (input.length > SHELL_CMD_TRUNCATE) {
        return { kind: "truncate-input", kept: input.slice(0, SHELL_CMD_KEEP) + "\n[REST OF COMMAND TRUNCATED]" }
      }
      if (out && overLimit(out, DEFAULT_LIMIT)) {
        const id = ctx.contentIdFor(out)
        return { kind: "replace-output", notice: `[Вывод команды опущён; Content ID: ${id}. Достань через read_omitted_content.]`, cache: true }
      }
      return { kind: "keep" }

    case "subagent":
    case "task":
      if (out && overLimit(out, TASK_OUTPUT_LIMIT)) {
        const id = ctx.contentIdFor(out)
        return { kind: "replace-output", notice: `[Вывод субагента опущён; Content ID: ${id}. Достань через read_omitted_content.]`, cache: true }
      }
      return { kind: "keep" }

    case "skill":
      if (out && overLimit(out, DEFAULT_LIMIT)) {
        return { kind: "replace-output", notice: "[Вывод скилла опущён (перезапускаем). Вызови скилл заново при необходимости.]", cache: false }
      }
      return { kind: "keep" }

    default:
      // webfetch/websearch/прочие: вывод → кэш при превышении
      if (out && overLimit(out, DEFAULT_LIMIT)) {
        const id = ctx.contentIdFor(out)
        return { kind: "replace-output", notice: `[Вывод ${name} опущён; Content ID: ${id}. Достань через read_omitted_content.]`, cache: true }
      }
      return { kind: "keep" }
  }
}

export type TurnPlan = {
  assistantIDs: string[]
  toolDecisions: Map<string, ToolDecision> // part.id → решение
}

/** Ход (turn) = user-сообщение + следующие assistant-сообщения до следующего user. */
export const splitTurns = (msgs: TransferMessage[]): { user: TransferMessage | null; assistants: TransferMessage[] }[] => {
  const turns: { user: TransferMessage | null; assistants: TransferMessage[] }[] = []
  for (const m of msgs) {
    if (m.type === "user") turns.push({ user: m, assistants: [] })
    else if (m.type === "assistant") {
      if (turns.length === 0) turns.push({ user: null, assistants: [] })
      turns[turns.length - 1].assistants.push(m)
    }
    // idle/system/synthetic/compaction — вне ходов
  }
  return turns
}

/** План трима: последние keepTurns ходов не трогаем, старше — решаем по правилам. */
export const planTrim = (msgs: TransferMessage[], keepTurns: number, ctx: RuleCtx): TurnPlan[] => {
  const turns = splitTurns(msgs)
  const fromTrim = Math.max(0, turns.length - keepTurns)
  return turns.map((t, i) => {
    const toolDecisions = new Map<string, ToolDecision>()
    if (i < fromTrim) {
      for (const a of t.assistants) {
        for (const p of a.content ?? []) {
          if (isToolPart(p)) toolDecisions.set(p.id, decideToolPart(p, ctx))
        }
      }
    }
    return { assistantIDs: t.assistants.map((a) => a.id), toolDecisions }
  })
}
