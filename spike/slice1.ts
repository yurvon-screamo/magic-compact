// Срез 1 v3: транспорт trim-ветки. Открытия v2 вшиты:
//   - message-id ГЛОБАЛЬНО уникальны (UNIQUE constraint): pre-flight import требует
//     перегенерации id сообщений (настоящему import после remove это не нужно)
//   - files живут в поле messages[].files (base64 data), не в content
//   - projectID не восстанавливается из info: import требует location
//   - промпты слать пачкой (admission), ожидание — один settle в конце
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const reg = JSON.parse(
  readFileSync(homedir() + "/.local/state/opencode/service.json", "utf8"),
);
const AUTH =
  "Basic " + Buffer.from("opencode:" + reg.password).toString("base64");
const BASE = String(reg.url).replace("0.0.0.0", "127.0.0.1") + "/api";
const LOC = "/tmp/opencode/arkive-loc";
const results: string[] = [];
const check = (name: string, ok: boolean, detail = "") =>
  results.push(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`,
  );
const rnd = (n: number) =>
  [...Array(n)]
    .map(
      () =>
        "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"[
          Math.floor(Math.random() * 62)
        ],
    )
    .join("");
const freshSid = () => "ses_e" + rnd(24);
const freshMid = () => "msg_" + rnd(20);
const reId = (msgs: any[]) => msgs.map(m => ({ ...m, id: freshMid() }));

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: AUTH,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не json */
  }
  return { status: res.status, json, text };
};

const mkSession = async (title: string) => {
  const r = await api("POST", "/session", {
    title,
    location: { directory: LOC },
    model: { providerID: "zai-coding-plan", id: "glm-5.3-flash" },
  });
  if (r.status !== 200)
    throw new Error("create: " + r.status + " " + r.text.slice(0, 200));
  return r.json.data.id as string;
};
const prompt = (sid: string, text: string) =>
  api("POST", `/session/${sid}/prompt`, { text });
const messages = async (sid: string) => {
  const list = (await api("GET", `/session/${sid}/message?limit=100`)).json
    .data as any[];
  return [...list].reverse(); // REST отдаёт DESC (новые сверху); хронология — снизу вверх
};
const assistantText = (m: any) =>
  (m.text ?? "").trim()
  || (m.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join(" ")
    .trim();
const settle = async (sid: string, users: number, timeoutMs = 120_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const msgs = await messages(sid);
    const u = msgs.filter(m => m.type === "user").length;
    const a = msgs.filter(
      m => m.type === "assistant" && assistantText(m).length > 0,
    ).length;
    if (u >= users && a >= users) return msgs;
    await new Promise(r => setTimeout(r, 2000));
  }
  return await messages(sid);
};
const exportT = async (sid: string) =>
  (await api("GET", `/experimental/session/${sid}/export`)).json.data;
const importT = (body: unknown) =>
  api("POST", "/experimental/session/import", body);
const remove = (sid: string) => api("DELETE", `/session/${sid}`);

// ——— B. транскрипт → pre-flight (перегенерённые id) → вставка капсулы в середину ———
let bSid = "",
  bTransfer: any = null;
{
  bSid = await mkSession("slice1-B order");
  for (const q of ["скажи один", "скажи два", "скажи три"])
    await prompt(bSid, q);
  await settle(bSid, 3);
  bTransfer = await exportT(bSid);
  const original = bTransfer.messages;
  const okSet =
    original.filter((m: any) => m.type === "user").length >= 3
    && original.filter((m: any) => m.type === "assistant").length >= 3;
  check(
    "B: транскрипт собран (3 user + 3 assistant)",
    okSet,
    `types=${original.map((m: any) => m.type[0]).join("")}`,
  );

  // pre-flight: капсула в середину + перегенерённые id сообщений + свежий session id + location
  const capId = freshMid();
  const t0 = original[0]?.time?.created ?? Date.now();
  const capsule = {
    id: capId,
    type: "user",
    time: { created: t0 + 1 },
    text: "[CAPSULE между 1 и 2]",
  };
  const withCapsule = [original[0], capsule, ...original.slice(1)];
  const pf = await importT({
    info: { ...bTransfer.info, id: freshSid() },
    messages: reId(withCapsule).map(m =>
      m.id === withCapsule[1].id ? { ...m, id: capId } : m,
    ),
    location: { directory: LOC },
  });
  check(
    "B: pre-flight import (re-id + location)",
    pf.status === 200,
    `status=${pf.status} ${pf.status !== 200 ? pf.text.slice(0, 140) : ""}`,
  );
  if (pf.status === 200) {
    const pfSid = pf.json.data.id;
    const after = await messages(pfSid);
    const idxCap = after.findIndex(m => m.text === "[CAPSULE между 1 и 2]");
    check(
      "B: капсула в середине",
      idxCap > 0 && idxCap < after.length - 1,
      `index=${idxCap}/${after.length}`,
    );
    const firstSrc = original[0].text ?? "";
    const neighbours = [after[idxCap - 1]?.text, after[idxCap + 1]?.text];
    const orderKept =
      idxCap > 0
      && neighbours[0] === firstSrc
      && neighbours[1] === (original[1]?.text ?? "");
    check(
      "B: ПОРЯДОК сохранён (соседи капсулы = исходные 1-е и 2-е)",
      orderKept,
      `соседи=${JSON.stringify(neighbours).slice(0, 90)}`,
    );
    const idsAfter = after.map((m: any) => m.id);
    const capsuleAt = idsAfter.indexOf(
      idsAfter.find((_, i) => after[i]?.text === "[CAPSULE между 1 и 2]") ?? "",
    );
    check(
      "B: хронология массива не пересортирована (капсула сразу после 1-го)",
      capsuleAt === 1,
      `позиция=${capsuleAt}`,
    );
    await remove(pfSid);
  }
  writeFileSync(
    "/tmp/opencode/slice1-b-transfer.json",
    JSON.stringify(bTransfer),
  );
}

// ——— C. files через roundtrip (поле files, не content) ———
{
  const sid = await mkSession("slice1-C media");
  const p2 = await api("POST", `/session/${sid}/prompt`, {
    text: "что на этой картинке? одним словом",
    files: [
      { uri: "file:///tmp/opencode/probe-scr.png", name: "probe-scr.png" },
    ],
  });
  await settle(sid, 1);
  const t = await exportT(sid);
  const src = t.messages.find((m: any) => (m.files ?? []).length > 0);
  check(
    "C: files в export (поле files, base64)",
    !!src,
    `prompt=${p2.status}, файлов: ${t.messages.reduce((n: number, m: any) => n + (m.files?.length ?? 0), 0)}`,
  );
  if (src) {
    const pf = await importT({
      info: { ...t.info, id: freshSid() },
      messages: reId(t.messages),
      location: { directory: LOC },
    });
    if (pf.status === 200) {
      const after = await messages(pf.json.data.id);
      const survived = after.some((m: any) =>
        (m.files ?? []).some((f: any) => (f.data ?? "").length > 1000),
      );
      check(
        "C: file пережил roundtrip",
        survived,
        `после: файлов ${after.reduce((n: number, m: any) => n + (m.files?.length ?? 0), 0)}`,
      );
      await remove(pf.json.data.id);
    } else
      check(
        "C: pre-flight import медиа",
        false,
        `status=${pf.status} ${pf.text.slice(0, 140)}`,
      );
  }
  await remove(sid);
}

// ——— D. tool-пары: удалить assistant с tool-частью ———
{
  const sid = await mkSession("slice1-D tools");
  await prompt(sid, "выполни bash-команду: echo slice1d и назови вывод");
  await settle(sid, 1);
  const t = await exportT(sid);
  const toolMsgs = t.messages.filter((m: any) =>
    (m.content ?? []).some((c: any) => c.type === "tool"),
  );
  check(
    "D: tool-сообщения в export",
    toolMsgs.length > 0,
    `tool-ассистентов=${toolMsgs.length}`,
  );
  if (toolMsgs.length > 0) {
    const dropped = new Set(toolMsgs.slice(0, 1).map((m: any) => m.id));
    const rest = t.messages.filter((m: any) => !dropped.has(m.id));
    const pf = await importT({
      info: { ...t.info, id: freshSid() },
      messages: reId(rest),
      location: { directory: LOC },
    });
    check(
      "D: import после удаления tool-ассистента",
      pf.status === 200,
      `status=${pf.status} ${pf.status !== 200 ? pf.text.slice(0, 140) : ""}`,
    );
    if (pf.status === 200) {
      const pr = await prompt(pf.json.data.id, "скажи: жива?");
      const done = await settle(pf.json.data.id, 1);
      const answered = done.some(
        (m: any) => m.type === "assistant" && assistantText(m).length > 0,
      );
      check(
        "D: после удаления tool-части агент отвечает",
        pr.status === 200 && answered,
        `prompt=${pr.status} answered=${answered}`,
      );
      await remove(pf.json.data.id);
    }
  }
  await remove(sid);
}

// ——— E. restore E2E ———
{
  const originalTransfer = JSON.parse(
    readFileSync("/tmp/opencode/slice1-b-transfer.json", "utf8"),
  );
  const spoiled = originalTransfer.messages.map((m: any, i: number) =>
    i === 0 ? { ...m, text: "[SPOILED]" } : m,
  );
  const pf = await importT({
    info: { ...originalTransfer.info, id: freshSid() },
    messages: reId(spoiled),
    location: { directory: LOC },
  });
  check(
    "E: pre-flight испорченной версии",
    pf.status === 200,
    `status=${pf.status}`,
  );
  if (pf.status === 200) await remove(pf.json.data.id);
  const rm = await remove(bSid);
  const imp = await importT({ info: originalTransfer.info, messages: spoiled });
  const spoiledSid = imp.status === 200 ? imp.json.data.id : null;
  check(
    "E: порча реальной (remove+import spoiled, родной id)",
    imp.status === 200,
    `rm=${rm.status} import=${imp.status}`,
  );
  if (spoiledSid) {
    const s1 = await messages(spoiledSid);
    check(
      "E: порча видна",
      s1.some((m: any) => m.text === "[SPOILED]"),
    );
    await remove(spoiledSid);
    const restore = await importT({
      info: originalTransfer.info,
      messages: originalTransfer.messages,
      location: { directory: LOC },
    });
    check(
      "E: restore из transfer (родной id + location)",
      restore.status === 200,
      `status=${restore.status}`,
    );
    if (restore.status === 200) {
      const sid2 = restore.json.data.id;
      const after = await messages(sid2);
      const same =
        after.length === originalTransfer.messages.length
        && after.every(
          (m: any, i: number) =>
            m.id === originalTransfer.messages[i].id
            && (m.text ?? "") === (originalTransfer.messages[i].text ?? ""),
        );
      check(
        "E: restore ИДЕНТИЧЕН (id/тексты/порядок)",
        same,
        `${originalTransfer.messages.length}→${after.length}`,
      );
      const users = after.filter((m: any) => m.type === "user").length;
      const pr = await prompt(sid2, "ответь одним словом: рестор");
      const done = await settle(sid2, users + 1);
      const answered =
        done.filter((m: any) => m.type === "assistant" && assistantText(m))
          .length > users;
      check(
        "E: промпт после restore → агент ответил",
        pr.status === 200 && answered,
        `prompt=${pr.status} answered=${answered}`,
      );
      // G: projectID при родном id + location
      const info2 = (await api("GET", `/session/${sid2}`)).json.data;
      check(
        "G: projectID сохранён (import с location)",
        info2?.projectID === originalTransfer.info.projectID,
        `до=${originalTransfer.info.projectID?.slice(0, 8)} после=${info2?.projectID?.slice(0, 8)}`,
      );
      await remove(sid2);
    }
  }
}

// ——— F. 404 ———
{
  const r = await prompt("ses_doesnotexist123", "тест");
  check(
    "F: prompt на мёртвую сессию → 404",
    r.status === 404,
    `status=${r.status}`,
  );
}

console.log(results.join("\n"));
const fails = results.filter(r => r.startsWith("FAIL")).length;
console.log(`\nитог: ${results.length - fails}/${results.length} PASS`);
