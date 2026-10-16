// Транспорт trim-ветки (срез 1 → код, ревью v2): roundtrip export/remove/import.
// Факты — docs/slice1-report.md: pre-flight с re-id + УДАЛЕНИЕМ после валидации,
// location обязателен, свежие id ses_e+24/msg_+20, семафор per-session на вызывателе,
// precondition «нет дочерних», dead-letter дрена, write-ahead omission-буфер.
import { type Transfer, type TransferMessage } from "./union";

const rnd = (n: number) =>
  [...Array(n)]
    .map(
      () =>
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"[
          Math.floor(Math.random() * 62)
        ],
    )
    .join("");
export const freshSid = () => "ses_e" + rnd(24);
export const freshMid = () => "msg_" + rnd(20);

export type SessionApi = {
  exportTransfer(sessionID: string): Promise<Transfer>;
  importTransfer(body: {
    info: Record<string, unknown>;
    messages: TransferMessage[];
    location?: { directory: string };
  }): Promise<{ status: number; id?: string; text: string }>;
  remove(sessionID: string): Promise<number>;
  inbox(sessionID: string): Promise<Array<{ id: string; text: string }>>;
  cancelInboxItem(sessionID: string, inboxID: string): Promise<number>;
  prompt(sessionID: string, text: string): Promise<number>;
  /** Список сессий локации для precondition «нет дочерних» (parentID-связь). */
  listSessions(): Promise<Array<{ id: string; parentID?: string | null }>>;
};

/** Перегенерация id сообщений (глобальная уникальность session_message.id). */
export const reIdMessages = (msgs: TransferMessage[]): TransferMessage[] =>
  msgs.map(m => ({ ...m, id: freshMid() }));

export type RewriteHooks = {
  /** Вызывается ДО remove: буфер omission-записей должен попасть на диск (write-ahead). */
  onOmissionsReady?: (count: number) => void;
  /** Катастрофа: сессия не восстановлена — дренированные промпты обязаны выжить. */
  onDeadLetter?: (drainedTexts: string[], error: string) => void;
};

/** Полный безопасный rewrite сессии (протокол среза 1 + ревью). Бросает при отказе. */
export const rewriteSession = async (
  api: SessionApi,
  sessionID: string,
  location: string,
  transform: (t: Transfer) => TransferMessage[],
  log: (s: string) => void = () => {},
  hooks: RewriteHooks = {},
): Promise<{ backup: Transfer }> => {
  // 0. precondition: у сессии нет дочерних (remove — рекурсивен по доке; судьба
  //    детей не гарантирована — отказываем с диагностикой, не молча)
  const sessions = await api.listSessions();
  const children = sessions.filter(s => s.parentID === sessionID);
  if (children.length > 0) {
    throw new Error(
      `у сессии ${sessionID} есть дочерние (${children.length}: ${children
        .slice(0, 3)
        .map(c => c.id)
        .join(", ")}…) — trim отменён (удаление родителя затронет их)`,
    );
  }

  // 1. бэкап: transfer (исходник) — вызывающий обязан был уже persist-ить omission-буфер
  const transfer = await api.exportTransfer(sessionID);
  const rewritten = transform(transfer);
  hooks.onOmissionsReady?.(rewritten.length);

  // 2. pre-flight: re-id + свежий id + location → структурная валидация → УДАЛИТЬ
  const pf = await api.importTransfer({
    info: { ...transfer.info, id: freshSid() },
    messages: reIdMessages(rewritten),
    location: { directory: location },
  });
  if (pf.status !== 200)
    throw new Error(
      `pre-flight import не прошёл: ${pf.status} ${pf.text.slice(0, 140)}`,
    );
  if (pf.id) {
    const pfRemoved = await api.remove(pf.id);
    if (pfRemoved !== 204)
      log(
        `pre-flight копия не удалилась (${pfRemoved}) — почисть вручную ${pf.id}`,
      );
  } else {
    log(`pre-flight 200 без id — копия не распознана, проверь список сессий`);
  }

  // 3. дрен inbox: cancel + тексты для пере-отправки (нетекстовые payload теряем только с логом)
  const inbox = await api.inbox(sessionID);
  const drainedTexts: string[] = [];
  let nonTextual = 0;
  for (const item of inbox) {
    if ((await api.cancelInboxItem(sessionID, item.id)) === 200) {
      if (item.text?.trim()) drainedTexts.push(item.text);
      else nonTextual++;
    }
  }
  if (nonTextual > 0)
    log(`дрен: ${nonTextual} inbox-итем(ов) без текста — не переотправим`);

  // 4. remove + import с родным id и РОДНЫМИ message-id (свободны после remove)
  const rm = await api.remove(sessionID);
  if (rm !== 204) {
    hooks.onDeadLetter?.(drainedTexts, `remove: ${rm}`);
    throw new Error(`remove: ${rm}`);
  }
  const imp = await api.importTransfer({
    info: transfer.info,
    messages: rewritten,
    location: { directory: location },
  });
  if (imp.status !== 200) {
    log(`import не прошёл (${imp.status}) — restore из бэкапа`);
    const retry = await api.importTransfer({
      info: transfer.info,
      messages: transfer.messages,
      location: { directory: location },
    });
    if (retry.status !== 200) {
      hooks.onDeadLetter?.(
        drainedTexts,
        `import ${imp.status}, restore ${retry.status}`,
      );
      throw new Error(
        `import упал (${imp.status}) и restore-ретрай тоже (${retry.status}): восстанови сессию из ${sessionID}-бэкапа вручную (runbook в docs/Core.md); дренированные промпты — в dead-letter`,
      );
    }
  }

  // 5. пере-отправка дренированных промптов; неудача — dead-letter (промпт не роняется)
  const failedDrain: string[] = [];
  for (const text of drainedTexts) {
    const st = await api.prompt(sessionID, text);
    if (st !== 200) {
      log(
        `дренированный промпт не переотправился (${st}): ${text.slice(0, 80)}`,
      );
      failedDrain.push(text);
    }
  }
  if (failedDrain.length > 0) {
    hooks.onDeadLetter?.(
      failedDrain,
      `re-prompt failed after successful rewrite`,
    );
  }
  return { backup: transfer };
};
