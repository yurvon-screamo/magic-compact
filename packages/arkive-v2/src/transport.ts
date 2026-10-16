// Транспорт trim-ветки (срез 1 → код): roundtrip export/remove/import.
// Все факты — из docs/slice1-report.md: pre-flight с re-id, location обязателен,
// свежие id формата ses_e+24/msg_+20, семафор per-session.
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
};

/** Перегенерация id сообщений (глобальная уникальность session_message.id). */
export const reIdMessages = (msgs: TransferMessage[]): TransferMessage[] =>
  msgs.map(m => ({ ...m, id: freshMid() }));

/** Полный безопасный rewrite сессии (срез-1 протокол).
 *  Возвращает id живой сессии (исходный при успехе; бросает при отказе). */
export const rewriteSession = async (
  api: SessionApi,
  sessionID: string,
  location: string,
  transform: (t: Transfer) => TransferMessage[],
  log: (s: string) => void = () => {},
): Promise<{ sessionID: string; backup: Transfer }> => {
  // 1. бэкап на диск делает вызывавший (здесь — вернуть transfer)
  const transfer = await api.exportTransfer(sessionID);
  const rewritten = transform(transfer);

  // 2. pre-flight: re-id + свежий session id + location → структурная валидация
  const pf = await api.importTransfer({
    info: { ...transfer.info, id: freshSid() },
    messages: reIdMessages(rewritten),
    location: { directory: location },
  });
  if (pf.status !== 200)
    throw new Error(
      `pre-flight import не прошёл: ${pf.status} ${pf.text.slice(0, 140)}`,
    );

  // 3. дрен inbox перед remove: cancel + тексты для пере-отправки после import
  const inbox = await api.inbox(sessionID);
  const drainedTexts: string[] = [];
  for (const item of inbox) {
    if ((await api.cancelInboxItem(sessionID, item.id)) === 200 && item.text)
      drainedTexts.push(item.text);
  }

  // 4. remove + import с родным id и РОДНЫМИ message-id (свободны после remove)
  const rm = await api.remove(sessionID);
  if (rm !== 204) throw new Error(`remove: ${rm}`);
  const imp = await api.importTransfer({
    info: transfer.info,
    messages: rewritten,
    location: { directory: location },
  });
  if (imp.status !== 200) {
    // 5. ретрай из бэкапа: импорт оригинала (идемпотентен по 409)
    const retry = await api.importTransfer({
      info: transfer.info,
      messages: transfer.messages,
      location: { directory: location },
    });
    if (retry.status !== 200)
      throw new Error(
        `import упал (${imp.status}) и restore-ретрай тоже (${retry.status}): сессию восстанови из backup-transfer вручную`,
      );
    log(`import не прошёл (${imp.status}), сессия восстановлена из бэкапа`);
  }
  // 6. пере-отправка дренированных промптов (текст сохранён до remove)
  for (const text of drainedTexts) {
    const st = await api.prompt(sessionID, text);
    if (st !== 200)
      log(
        `дренированный промпт не переотправился (${st}): ${text.slice(0, 80)}`,
      );
  }
  return { sessionID, backup: transfer };
};
