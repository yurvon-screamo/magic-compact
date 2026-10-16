// Срез 2 (PLAN.md): V2-union — типы и хелперы над export-массивом OpenCode V2.
// Сообщение: {id, type, time, text?, content?[], files?[], ...agent поля}
// Хронология export — ASC (как в transfer); REST message-list — DESC.
// assistant-текст живёт в content[].text (type:"text"), НЕ в m.text.

export type ToolPart = {
  type: "tool"
  id: string
  name: string
  executed?: boolean
  state?: {
    status?: string
    input?: unknown
    content?: Array<{ type: string; text?: string } | Record<string, unknown>>
    metadata?: unknown
  }
  time?: unknown
}

export type Part = ToolPart | { type: string; [k: string]: unknown }
export type TransferMessage = {
  id: string
  type: string // user | assistant | idle | system | compaction | shell | synthetic | ...
  time?: { created?: number; completed?: number }
  text?: string
  content?: Part[]
  files?: Array<{ data?: string; [k: string]: unknown }>
  [k: string]: unknown
}
export type Transfer = { info: Record<string, unknown>; messages: TransferMessage[] }

/** Видимый текст assistant-сообщения (content text-парты; fallback m.text). */
export const assistantText = (m: TransferMessage): string =>
  (m.text ?? "").trim()
  || (m.content ?? []).filter((p) => p.type === "text").map((p) => (p as any).text ?? "").join(" ").trim()

/** Текстовая проекция tool-вывода (state.content — массив частей). */
export const toolOutputText = (p: ToolPart): string =>
  (p.state?.content ?? []).map((c: any) => c?.text ?? "").join("\n").trim()

/** Текстовая проекция tool-входа. */
export const toolInputText = (p: ToolPart): string => {
  const i = p.state?.input as Record<string, unknown> | undefined
  if (!i) return ""
  // у shell: command; у edit/write: content/oldString/newString; прочее — JSON
  for (const k of ["command", "content", "oldString", "newString", "file_path", "path", "pattern", "query", "prompt"]) {
    if (typeof i[k] === "string") return i[k] as string
  }
  try { return JSON.stringify(i) } catch { return "" }
}

export const isToolPart = (p: Part): p is ToolPart => p.type === "tool"
export const hasTools = (m: TransferMessage) => (m.content ?? []).some(isToolPart)

// ——— токен-оценка: слова/символы по мотивам V1 (docs/Core.md) ———
export const countWords = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0)
export const textVolume = (s: string) => ({ words: countWords(s), chars: s.length })
export const overLimit = (s: string, limit: { words: number; chars: number }) => {
  const v = textVolume(s)
  return v.words > limit.words || v.chars > limit.chars
}
