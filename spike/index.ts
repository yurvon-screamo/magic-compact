// Срез 0 (PLAN.md): спайк нативного compaction-hook OpenCode V2.
// Отвечает на вопросы ADR:
//   1. Зовётся ли hook "compaction" на ручном session.compact?
//   2. Что лежит в event.messages (типы, объём)?
//   3. Можно ли внутри хука делать N× ctx.generate.text и за какое время?
//   4. Принимается ли event.result = { summary, recent } — пропускается ли
//      нативный вызов модели компакшна?
// Лог: /tmp/opencode/arkive-spike.log
import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"

const LOG = "/tmp/opencode/arkive-spike.log"
const log = (line: string) => {
  appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
}

const FLASH = { providerID: "zai-coding-plan", id: "glm-5.3-flash" }

export default Plugin.define({
  id: "arkive-spike",
  setup(ctx) {
    log(`spike loaded (app ${ctx.app.version}, location ${ctx.location.directory})`)

    void ctx.session.hook("compaction", async (event: any) => {
      const t0 = Date.now()
      const msgs: any[] = event.messages ?? []
      const types = msgs.map((m) => m?.type ?? m?.role ?? "?")
      const counts: Record<string, number> = {}
      for (const t of types) counts[t] = (counts[t] ?? 0) + 1
      log(`compaction hook: session=${event.sessionID} messages=${msgs.length} types=${JSON.stringify(counts)}`)
      log(`  event keys: ${Object.keys(event).join(", ")}`)

      // 3 последовательных generate.text внутри хука — латентность/реентерабельность
      const capsules: string[] = []
      for (let i = 1; i <= 3; i++) {
        const tg = Date.now()
        try {
          const out = await ctx.generate.text({
            model: FLASH,
            prompt: `Одной фразой (до 12 слов), что произошло на шаге ${i}: вернулась цифра ${i * 7}.`,
          })
          capsules.push(`Шаг ${i}: ${String(out).slice(0, 120)}`)
          log(`  generate#${i}: ok за ${Date.now() - tg}ms`)
        } catch (e) {
          log(`  generate#${i}: FAIL ${String(e).slice(0, 140)}`)
          capsules.push(`Шаг ${i}: (generate недоступен)`)
        }
      }

      event.result = {
        summary: "ARKIVE-SPIKE капсульный саммари (модельный вызов нативного компакшна должен быть пропущен):\n"
          + capsules.map((c) => `- ${c}`).join("\n"),
        recent: "(спайк: хвост recent подменён)",
      }
      log(`  result записан; всего хук жил ${Date.now() - t0}ms`)
    })
  },
})
