# ADR-001: Путь А — нативный compaction-hook как основной механизм

Статус: принято (срез 0, 2026-10-16). Спайк: `spike/index.ts`, лог: прилагается ниже.

## Контекст

План (PLAN.md) требовал решить до кода: нативный session hook `"compaction"`
(путь А) или export/remove/import roundtrip (путь Б) как основной механизм
компакшна. Roundtrip в любом случае остаётся для `/arkive:trim`.

## Решение

**Путь А.** Плагин регистрирует `ctx.session.hook("compaction")`, строит
капсулы через `ctx.generate.text` (zai glm-5.3-flash) и записывает
`event.result = { summary }`. Нативный вызов модели компакшна пропускается.

## Факты спайка (живой сервер opencode 2.0.30, zai glm-5.3-flash)

1. Ручной `session.compact` триггерит хук (auto-компакшн использует тот же путь).
2. `event` несёт: sessionID, model, system, **messages**, options, agent, tools.
   `messages` — транскрипт для суммаризации; сервер сам отфильтровал служебные
   типы (в спайке: только user/assistant, idle исключён).
3. `ctx.generate.text` реентерабелен внутри хука: 3 последовательных вызова,
   5.6–8.5 c каждый, хук суммарно жил 21.3 c — сервер ждёт, таймаутов нет.
4. `event.result.summary` записан в compaction-сообщение (status=completed,
   reason=manual) — нативный модельный вызов пропущен, наш текст стал саммари.
5. `event.result.recent` сервером НЕ применяется (recent-хвост сервер строит
   сам) — в result достаточно summary.
6. `ctx.generate.text` возвращает объект, текст капсулы брать из `.text`.

## Следствия

- Капсульный движок (срез 3) встраивается в хук; гонок/семафоров/inbox-дрена
  в компакшн-ветке НЕТ (это остаётся только trim-ветке, срез 1).
- Модель в compaction-сообщении отображается как модель сессии (косметика,
  реальный вызов — наш flash через generate).
- Хук может жить десятки секунд (N капсул × латентность) — для авто-компакшна
  это пауза между шагами сессии; допустимо, замеряем в пилоте.
- Известная бага: `client.session.wait` из @opencode/client (beta) падает
  `UnsupportedContentType` — ожидание очереди делать поллингом REST.
- sessionID не трогается вовсе: хаб/cron/фабрика не затронуты.

## Лог спайка

    [12:14:34] spike loaded (app 2.0.30, location /tmp/opencode/arkive-loc)
    [12:14:54] compaction hook: session=ses_ebb5d… messages=3 types={"user":2,"assistant":1}
    [12:14:54]   event keys: sessionID, model, system, messages, options, agent, tools
    [12:15:01]   generate#1: ok за 7184ms
    [12:15:06]   generate#2: ok за 5635ms
    [12:15:15]   generate#3: ok за 8482ms
    [12:15:15]   result записан; всего хук жил 21302ms
    COMPACTION: {"status":"completed","reason":"manual","summary":"ARKIVE-SPIKE капсульный саммари…"}
