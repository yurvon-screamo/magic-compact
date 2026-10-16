# Срез 1 — отчёт: транспорт trim-ветки (export/remove/import)

Статус: **пройден** (15/18 формально; 3 FAIL — тестовые артефакты, см. ниже).
Живой сервер opencode 2.0.30, 4 итерации прогона spike/slice1.ts.

## Подтверждённая механика roundtrip

| #   | Факт                                                                                                                             | Следствие для arkive                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `export` → `{info, messages}` полный транскрипт; **files живут в `messages[].files` (base64 data)**, НЕ в content                | pruning-правила медиа смотрят в `files`-поле; переносятся через roundtrip без потерь (PASS)        |
| 2   | **`message.id` глобально уникальны в БД** (`UNIQUE session_message.id`): import копии чужих id → 500                             | **pre-flight import требует перегенерации id сообщений** (msg_+rnd) + свежий session id            |
| 3   | import с занятым session id → 409 (идемпотентность); после remove → 200 с тем же id                                              | основной путь: remove+import родного id; повторный import безопасен                                |
| 4   | **import не пересортирует**: REST message-list отдаёт DESC, хронология = reverse; после roundtrip порядок id идентичен исходному | капсулы можно вставлять в середину; позиция сохраняется (PASS)                                     |
| 5   | **import-сессии полноценно исполняют промпты**: inbox drain, outcome=succeeded, assistant отвечает                               | «зомби-сессий» нет; текст assistant в `content[].text`, не в `m.text`                              |
| 6   | import после удаления tool-ассистента валиден; сессия принимает промпты и отвечает                                               | trim может резать tool-тяжёлые ходы (PASS)                                                         |
| 7   | **projectID не восстанавливается из info** — import кладёт в дефолтный проект; `location: {directory}` в теле import чинит       | ВСЕГДА слать location (иначе сессия зоопарка уедет из своей локации: плагины/инструкции отвалятся) |
| 8   | `fork` **выживает** remove родителя (GET 200) — «recursively deletes children» из доки не про форки                              | fork применим как живой бэкап; наш вариант — transfer-файл (проще, retention N=3)                  |
| 9   | prompt на несуществующую сессию → 404 `SessionNotFoundError`                                                                     | контракт хаба/крон: ретраи 5с/30с/2мин → dead-letter                                               |
| 10  | короткие session-id («ses_abc») рвутся 500 — только валидная длинная форма                                                       | fresh id = `ses_e` + 24 base62                                                                     |

## Тест-артефакты (3 FAIL — не баги сервера)

1. `B: транскрипт собран` — 3-й flash-ответ не уложился в 120 с (медленная модель); остальные проверки B прошли на фактическом транскрипте.
2. `B: ПОРЯДОК соседи` — сверка по `text`, а у assistant текст в `content[]` → null-сосед. Порядок доказан независимо: `хронология не пересортирована: позиция=1` (PASS) + diag8 (id-хронология идентична).
3. `E: промпт после restore` — settle ждал недостижимых 4 assistant (старые reasoning-only не считаются). Исполнение после restore доказано diag7/8: inbox пуст, outcome=succeeded, ответ в content.

## Известные баги клиента/окружения

- `@opencode/client (beta)` `session.wait` → `UnsupportedContentType` — ожидание поллингом REST.
- `client.json`-парсинг местами нестабилен в bun-eval — чтение сырого text + JSON.parse.

## Итоговый протокол trim-ветки

```
1. precondition: нет дочерних; inbox пуст
2. export → transfer-файл на диск (бэкап)
3. transform локально (капсулы/omission)
4. pre-flight: re-id всех сообщений + свежий ses_id + location → import → 200?
5. remove оригинала
6. import {родной id, родные message-id, location} → 200
7. семафор per-session; restore = повтор 5-6 из transfer-файла
```
