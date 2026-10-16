// Transform (срез 2, ревью v2): применение плана трима к transfer-массиву.
// Чистая функция: (transfer, план, кэш) → {messages, stats}
// Инварианты: user-сообщения и files НЕ трогаем никогда; порядок сохраняем;
// не-текст части tool-вывода (медиа) не сносим; всё вырезанное → кэш (retrievable).
import {
  type Transfer,
  type TransferMessage,
  type ToolPart,
  isToolPart,
} from "./union";
import { type TurnPlan } from "./rules";
import { type OmissionStore, put } from "./omission";

export type TransformResult = {
  messages: TransferMessage[];
  stats: {
    replaced: number;
    kept: number;
    truncated: number;
    bytesCached: number;
  };
};

export const applyTrim = (
  transfer: Transfer,
  plans: TurnPlan[],
  store: OmissionStore,
): TransformResult => {
  const decisionsByAssistant = new Map<string, TurnPlan>();
  for (const plan of plans)
    for (const id of plan.assistantIDs) decisionsByAssistant.set(id, plan);

  const stats = { replaced: 0, kept: 0, truncated: 0, bytesCached: 0 };
  const messages = transfer.messages.map(m => {
    if (m.type !== "assistant") return m; // user/idle/system/... — нетронуты
    const plan = decisionsByAssistant.get(m.id);
    if (!plan || plan.toolDecisions.size === 0) return m;

    const content = (m.content ?? []).map(p => {
      if (!isToolPart(p)) return p;
      const d = plan.toolDecisions.get((p as ToolPart).id);
      if (!d || d.kind === "keep") {
        stats.kept++;
        return p;
      }

      if (d.kind === "replace-output") {
        if (d.cacheContent) {
          put(store, (p as ToolPart).name, d.cacheContent);
          stats.bytesCached += d.cacheContent.length;
        }
        stats.replaced++;
        const part = structuredClone(p) as ToolPart;
        // не-текст части вывода (медиа и пр.) сохраняем — сносим только текст
        const nonText = (part.state?.content ?? []).filter(
          c => (c as { type?: string }).type !== "text",
        );
        part.state = {
          ...(part.state ?? {}),
          content: [...nonText, { type: "text", text: d.notice }],
        };
        return part;
      }
      if (d.kind === "replace-input") {
        if (d.cacheContent) {
          put(store, (p as ToolPart).name, d.cacheContent);
          stats.bytesCached += d.cacheContent.length;
        }
        stats.replaced++;
        const part = structuredClone(p) as ToolPart;
        part.state = { ...(part.state ?? {}), input: { omitted: d.notice } };
        return part;
      }
      // truncate-input: полную команду в кэш, в контекст — усечённую
      if (d.cacheContent) {
        put(store, (p as ToolPart).name, d.cacheContent);
        stats.bytesCached += d.cacheContent.length;
      }
      stats.truncated++;
      const part = structuredClone(p) as ToolPart;
      part.state = {
        ...(part.state ?? {}),
        input: { command: d.kept, truncated: true },
      };
      return part;
    });
    return { ...m, content };
  });

  return { messages, stats };
};
