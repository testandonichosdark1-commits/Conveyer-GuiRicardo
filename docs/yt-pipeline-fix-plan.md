# YouTube-pipeline — план устранения багов

> Рабочий план по закрытию проблем из [yt-pipeline-known-issues.md](yt-pipeline-known-issues.md).
> Порядок: дешёвые низкорисковые победы → ядро качества → архив → резистентность → апстрим →
> оптимизация. Каждый work-item (WI) — отдельный минимальный патч, флагуемый где уместно,
> `npx tsc --noEmit` после, измеряемый на тех же прогонах. Правки скорер-логики и планировщика —
> proposal-first перед кодом. Статус: ⬜ не начато · 🟦 proposal готов · ✅ сделано.

---

## Фаза 1 — дешёвые низкорисковые победы (быстро, чистят пул для Фазы 2)

### ✅ WI-1 · Title-prefilter мусора до скачивания  → закрывает B4, частично B2/B3
- **Что:** в `acquireYouTube` расширить hard-exclusion заголовков: добавить маркеры sound-effect/ambience (`sound effect`, `\bSFX\b`, `white noise`, `sounds (24/7|for sleep)`, `\bASMR\b`) — они дают текст-карточку+аудио, гарантированный мусор. Отсев ДО скачивания → экономит цикл + слот кандидата.
- **Файл/функция:** `visual-source.ts` → `YT_LOWQUALITY_TITLE` (regex) + `isClickbait`.
- **Blast radius:** одна regex-константа. **Риск:** низкий (высокоточные маркеры; не заденет реальный b-roll).
- **Verify:** Beat-39-подобные «Small Stream Flowing [SOUND EFFECT]» исчезают из кандидатов в логах.

### ✅ WI-2 · Архивная augmentation: не плодить пустые поиски  → закрывает B1 (частично; per-candidate re-search → WI-8)
- **Что:** (1) убрать слово `newsreel` из augmentation (оно даёт `no-results` на нишевых запросах); оставить мягкое `archival footage` ИЛИ вовсе только bare-query для `query_type=entity` нишевых субъектов. (2) Не ре-augmentировать на КАЖДОМ кандидате — augmentation только на первом поиске.
- **Файл/функция:** `visual-source.ts` → `acquireYouTube` (`augmented`/`tries`).
- **Blast radius:** блок построения запроса. **Риск:** низкий (меньше пустых поисков; архивные хиты не теряем — bare-query как был).
- **Verify:** пропадают парные `[no-results] … archival footage newsreel` на каждом кандидате; латентность архив-битов падает.

### ✅ WI-3 · Точность domain для Fix 1  → закрывает E1
- **Что:** в `coarseFootageKind` маппить в `archival` ТОЛЬКО при высокой уверенности (history по году 18xx/19xx), а не по любому history-ключевику — иначе современный бит («NVIDIA…» c domain=history) при выгорании плана получает archival-роутинг.
- **Файл/функция:** `studio-plan.ts` → `coarseFootageKind` (+ возможно отдельный признак «history-by-year»).
- **Blast radius:** один helper. **Риск:** низкий (срабатывает лишь при полном выгорании Gemini-плана).
- **Verify:** node-тест: «NVIDIA gaming…» с domain=history НЕ даёт archival.

---

## Фаза 2 — ЯДРО качества (headline-фикс; proposal-first перед кодом)

### ✅ WI-4 · Переработка приёмки клипа + best-of-N  → закрывает C1, C4 (offline 15/15; live-прогон ожидается)
- **Проблема:** consensus/rescue награждают ПИКИ, не консистентность; цикл берёт ПЕРВЫЙ прошедший, а не ЛУЧШИЙ. Итог: `[0,0,100,100]` (полклипа мёртвое) бьёт `[30,30,80,70]` (ровный, без провалов).
- **Что (черновик, уточню в proposal):**
  - Метрика клипа на основе **пола/консистентности**: например `clipScore = mean со штрафом за dead-frames (<40)`, и hard-reject если dead-frames > K. Тогда min-30-клип обходит клип с двумя нулями.
  - **best-of-N:** не `return` на первом прошедшем — скорить до N кандидатов, брать лучший по `clipScore`; ранний выход только если кандидат отличный (`clipScore ≥ высокий бар`), чтобы ограничить латентность.
  - Сохранить text-veto (T1/T2) и порог как floor.
- **Файл/функция:** `visual-source.ts` → `youtubeScoredFallback` (accept-блок + структура цикла).
- **Blast radius:** одна функция, но меняется семантика приёмки + поток цикла. **Риск:** средний — поэтому **сначала proposal-first** с точной формулой и прогоном на сохранённых debug_frames.
- **Verify:** на примере пользователя `[30,30,80,70]` ⟶ выбран над `[0,0,100,100]`; ровные 70-80 клипы (Beat 10/17) перестают случайно вылетать; «спайк»-приёмки (Beat 3/4/28/31) уходят.

---

## Фаза 3 — архивный путь

### ✅ WI-5 · footage_kind-gated text-veto  → закрывает D1
- **Что:** прокинуть `footageKind` в `scoreLocalImage`; для `archival` терпеть интертитры/плашки (старый режим), для `contemporary` давить текст (T1/T2 как сейчас). Это согласованный «вариант C».
- **Файл/функция:** `visual-source.ts` → сигнатура `scoreLocalImage` (+ вызов из `youtubeScoredFallback`) и гейт по `text`.
- **Blast radius:** сигнатура + один вызов + условие гейта. **Риск:** низко-средний (расширение сигнатуры). **proposal-first** (рубрика).
- **Verify:** настоящая хроника (Beat 23 «1937 Switzerland newsreel») для archival-бита проходит; contemporary с субтитрами по-прежнему режется.

---

## Фаза 4 — резистентность к провайдерам

### ✅ WI-6 · Устойчивость к падению kie.ai  → закрывает A1
- **Что:** бэкофф/ретраи для kie.ai `internal error`; при устойчивом отказе — fallback на 69labs/Grok вместо «провала бита». Не считать kie-сбой за потерю, если есть чем заменить.
- **Файл/функция:** `visual-source.ts` → `acquireAi` (kie-ветка) / `kie.ts`.
- **Blast radius:** AI-ветка. **Риск:** низко-средний. **Verify:** при форс-фейле kie бит уходит на 69labs, прогон не аборится.
- *(A2/A3 Gemini-503 — вне нашего контроля; ретраи+lexical уже есть. A4 Pexels-fetch — уже обрабатывается. Не чиним.)*

---

## Фаза 5 — апстрим: качество запросов (planner; proposal-first)

### 🟦 WI-7 · Query-shaping в планировщике  → закрывает G1 (ядро ✅), C2/B3 (B+C отложены)
**Сделано (ядро, offline-validated):** footage-shaped `keywordsFrom` — entity-first + `QUERY_FILLER` + cap 5 (чинит активный Gemini-503 fallback-путь). **Отложено:** (B) доменный/scriptContext-якорь, (C) prompt-клауза «один визуал на бит» (C2) — требует живого Gemini для валидации.
**+ Gemini-resilience (root-cause A2):** лестница ретраев `requestPlanChunk` диверсифицирована через поколения (2.5 → 2.0, отдельный пул мощностей) — спайк 2.5 больше не валит весь план. Account-side рычаг: платный тариф ключа (free-tier ловит 503 в разы чаще).
- **Что:** (1) не склеивать две картинки в один запрос («Elon on stage Gigafactory» → один визуал на бит); (2) footage-shaped fallback вместо narration-keywords при выгорании Gemini; (3) доменный якорь в запросе, чтобы убрать коллизии («screen»→gaming).
- **Файл/функция:** `studio-plan.ts` → `buildPlanPrompt` / `planVisualQueries` / `keywordsFrom`.
- **Blast radius:** промпт/фоллбэк планировщика. **Риск:** средний (меняет апстрим-выход). **proposal-first**.
- **Verify:** запросы — один визуал; B3-коллизии (gaming/iPhone под hydro) пропадают; C2 (SpaceX↔Tesla) снимается на уровне запроса.

---

## Фаза 6 — оптимизация (последней, когда корректность закрыта)

### ✅ WI-8 · Не ре-серчить на каждого кандидата  → закрывает F1
- **Что:** `acquireYouTube` расщеплён на `searchYouTube` (поиск+ранжирование, 1 раз/бит, метаданные без скачивания, `usedIds` только для фильтра) и `downloadYouTube` (скачивание сегмента ОДНОГО кандидата). `youtubeScoredFallback` делает один `searchYouTube` до цикла, затем best-of-N качает кандидатов из готового ранкинга; неудачное скачивание двигает указатель по ранкингу (слот скоринга не тратится).
- **Файл/функция:** `visual-source.ts` → `searchYouTube` + `downloadYouTube` (новые) + цикл в `youtubeScoredFallback`.
- **Blast radius:** одна функция расщеплена на две + перепроводка единственного вызова. Поведение приёмки/скоринга (WI-4/5) не тронуто. **Риск:** средний (рефактор retrieval), поведение-сохраняющий.
- **Сделано:** `npx tsc --noEmit` 0 ошибок. Один `ytsearch` на бит вместо N; внутренний cap `checked>=3` убран (ранкинг ≤12 — естественная граница). Live-замер латентности ожидается.

---

## Фаза 7 — повышение YouTube-доли без ослабления качества

### ✅ WI-9 · Сегмент-ретрай: чистое окно того же видео при text-вето  → поднимает D3-потолок
- **Что:** когда YouTube-кандидат отбракован **по тексту**, но не-текстовые кадры сами проходят бар (`mean(scored) ≥ clipBar`, `scored.length ≥ 2`, `!deadVeto`) — клип релевантен, просто окно зацепило подписи. Вместо отказа качаем ДРУГОЕ окно того же видео (`nextSegmentStart`, non-overlapping spread) до `YT_SEGMENT_RETRIES` раз; каждое окно полноценно пере-скорится (text/dead-вето + clipScore без изменений).
- **Файл/функция:** `visual-source.ts` → `downloadYouTube` (+`startOverride`), новый `nextSegmentStart`, внутренний while по окнам в `youtubeScoredFallback`. `settings.ts` → `YT_SEGMENT_RETRIES` (default **1**; `0` = выкл/откат).
- **Blast radius:** download/accept-поток YouTube. **Риск:** средний — митигирован узким триггером (только релевантно-текстовые клипы), per-video cap, non-overlap, early-exit. text-вето/скорер НЕ ослаблены.
- **Сделано:** `npx tsc --noEmit` 0 ошибок; `nextSegmentStart` offline-валидирован (спред/дедуп/non-overlap/отказ на коротких). Триггер НЕ срабатывает на `[TEXT×5]` (scored пуст) и off-topic. Live-замер hit-rate ожидается; при сильном hit-rate поднять default до 2.

### ✅ WI-10 · Глубокий sweep + b-roll source-shaping  → атакует потолок persistent-captions
- **Рычаг 1 (sweep, риск 0):** `YT_CANDIDATES` 3→**6** (клапм 5→12), `searchN` 12→**15**. Скорим больше кандидатов из более глубокого пула; приёмка/early-exit не тронуты.
- **Рычаг 2 (shaping, под флагом `YT_BROLL_SHAPING=1`):** contemporary-запрос augment `"… cinematic b roll"` (bare-query fallback сохранён); ре-тиринг ранкинга single-membership — `YT_BROLL` (4k/aerial/drone/cinematic/b-roll/stock footage) вперёд, `YT_NEWSY` (news/cnbc/bloomberg/«how…works»/interview/review) в хвост (даунранк, не эксклюд). Для archival порядок `[arch, broll, …]`.
- **Конфиг (подтверждён):** `YT_CANDIDATES=6`, `YT_SEGMENT_RETRIES=1` (без изменений), `YT_BROLL_SHAPING=1`.
- **Файл/функция:** `visual-source.ts` → `searchYouTube` (augmentation + тиринг), `youtubeScoredFallback` (клапм); `settings.ts` (+1 ключ, 1 дефолт).
- **Что НЕ тронуто:** text-veto/clipScore/best-of-N/WI-9/`downloadYouTube`/планировщик/кадрирование.
- **Сделано:** `npx tsc --noEmit` 0; regex-тиринг offline-валидирован на реальных заголовках («How data centers work»→newsy, 4K/drone/cinematic→broll). `YT_BROLL_SHAPING=0` = мгновенный откат. Live-замер ratio (1 vs 0) ожидается.

### ✅ WI-12 · Дедуп-гонка: один и тот же клип на двух битах (регрессия WI-8)
- **Баг (поймал пользователь, `run_5cadd0ca`):** Beat 4 и Beat 6 получили ОДНО видео `blW-Fa4a10g` «Giga Berlin Fly Through 2.0», отрезки 76-84 vs 76-85s — визуальный дубликат. Корень: `usedIds` фильтруется только в момент поиска; WI-8 заморозил ранкинг на бит; параллельные биты держали один id в своих списках и оба скачали (Beat 6 @17:58:35, Beat 4 @17:59:12).
- **Фикс:** в начале цикла кандидатов `youtubeScoredFallback` — синхронный check-and-claim (`if (usedIds.has(key)) continue; usedIds.add(key);`) ДО `await` скачивания → атомарно, два бита один id не возьмут. `downloadYouTube`-овский `add` стал дублирующим (no-op).
- **Файл:** `visual-source.ts` → `youtubeScoredFallback` (3 строки). **Риск:** низкий; скоринг/качество не тронуты. `npx tsc --noEmit` 0.

### ✅ WI-13 · Query-shaping: трим абстрактных хвостов в планировщике  → чинит коллизии класса Beat 4
- **Баг (`run_35bb3e28` Beat 4):** Gemini `visual_query="Battery production lines scaling energy output"` — верный субъект + недепиктируемый хвост «scaling energy output» утянул выдачу в энергетику/солар/физику → все 6 кандидатов off-topic → сток.
- **Фикс:** код-сторона, БЕЗ правки Gemini-промпта. Новый `ABSTRACT_QUERY_TERMS` (узкий список: scaling/scale/output/powering/revolution/.../intelligence — депиктируемые НЕ включены) + helper `shapeFootageQuery` (трим токенов, fail-safe: <2 слов → оригинал). Применён к `visualQuery` (реальный поиск), `aiPrompt` не тронут. Флаг `PLAN_QUERY_TRIM="1"` (0 = откат).
- **Файл:** `studio-plan.ts` (набор + helper + 2 строки в сборке бита + debug-лог трима); `settings.ts` (+1 ключ). **Риск:** низкий (детерминированный постфильтр, fail-safe, флаг).
- **Сделано:** `npx tsc --noEmit` 0; offline: «Battery production lines scaling energy output»→«Battery production lines energy», «… powering intelligence»→«data center infrastructure», named-entity запросы без изменений, короткие не пустеют. **НЕ чинит полисемию (screen/leaves)** — это отдельный (не утверждённый) доменный якорь.

### ✅ WI-11 · Crop-recovery: вырезать caption-полосу из релевантного клипа  → последний рычаг по тексту
- **Что:** клип релевантен (90/95), но зарезан подписью, и segment-retry не нашёл чистого окна → детект региона текста → если `lower`/`upper` полоса → кроп + zoom-to-fill (аспект сохранён) → пере-скор → принять, если чисто. `center`/`full`/`scattered` → отказ (кроп убьёт субъект).
- **Порядок:** ПОСЛЕ WI-9 segment-retry (полный кадр предпочтён зуму) — crop только last-resort.
- **Изоляция:** новый `detectTextRegion` (отдельный vision-вызов, scoreLocalImage НЕ тронут), `cropClip` (ffmpeg crop+scale+crop, точные пиксели через ffprobe), `tryCropRecovery` (детект→кроп→пере-скор→замена tmpClip). Пере-скор — hard-gate: текст-остаток/срезанный субъект отбракуются штатно.
- **Файл:** `visual-source.ts` (3 helper + crop-блок в per-candidate flow). `settings.ts`: `YT_CROP_RECOVERY="1"`, `YT_CROP_FRACTION="0.22"`.
- **Что НЕ тронуто:** scoreLocalImage рубрика/тип, WI-4/9/10/12/13. Crop — аддитивная ветка.
- **Сделано:** `npx tsc --noEmit` 0; ffmpeg crop-фильтр провалидирован end-to-end (1280×720 → 1280×720, нижние 22% срезаны, аспект сохранён). **Риск:** средний-высокий (меняет кадрирование) — митигирован пере-скором, узким триггером, порядком-после-retry, флагом. Live-валидация ожидается.

### ✅ WI-11a · Доработка crop-recovery: лучшее окно + строгий region-консенсус
- **Доработка 1 (multi-frame консенсус):** `tryCropRecovery` детектит регион на ≤3 ТЕКСТОВЫХ кадрах (новый параметр `textFractions`); кропает ТОЛЬКО при согласии на ОДНУ полосу (`lower` XOR `upper`) и БЕЗ `center`/`full`/`scattered`. Чинит `run_8913aac0` Beat 3 (одно-кадровый probe мислейбил → crop усиливал текст; теперь scattered/center → skip).
- **Доработка 2 (лучшее окно):** в `youtubeScoredFallback` — аккумулятор `cropCand` (лучшее по `mean` релевантно-текстовое окно, копия до перезаписи retry); crop перенесён ИЗ window-цикла → ПОСЛЕ него, на `cropCand` (не на последнее окно). Чинит затенение segment-retry (Beat 0 cand3 `[TEXT,60,90,60,90]` терялся). Атрибуция — `candAttribution` (то же видео для всех окон). Чистка `cropCand.path` во всех выходах; при приёме чистого окна `cropCand` сбрасывается (полный кадр > зум).
- **Файл:** `visual-source.ts` (`tryCropRecovery` region-блок + сигнатура; per-candidate flow). Новых ключей НЕТ; скорер/пороги/re-score-gate не тронуты.
- **Сделано:** `npx tsc --noEmit` 0; консенсус offline-валидирован (`[lower,lower,none]`→lower; `[upper,center,lower]`→skip; `[scattered,upper,upper]`→skip; `[lower,upper]`→skip). Re-score-gate и `YT_CROP_RECOVERY=0` откат — без изменений. Live-валидация ожидается.

---

## Не-баги (зафиксировано, не чиним)
- **D2** — explainer/tutorial-темы text-насыщены → ниже YouTube-ratio. Осознанный размен «чисто > YouTube».
- **G2** — стоковый пул без thumbnails → слабее отбор. Минор.
- **A2/A3** — Gemini 503 (внешнее, graceful-обработка уже есть).

---

## Рекомендуемый порядок исполнения
1. **Фаза 1** (WI-1, WI-2, WI-3) — три маленьких низкорисковых патча, можно подряд; чистят пул и латентность, готовят почву.
2. **WI-4** (ядро, proposal-first) — главный фикс качества (C1+C4), на котором держится «правильный выбор клипа».
3. **WI-5** (D1, proposal-first) — архив перестаёт терять хронику.
4. **WI-6** (A1) — резистентность.
5. **WI-7** (планировщик, proposal-first) — апстрим-качество запросов.
6. **WI-8** (латентность) — после корректности.

После каждого WI: `npx tsc --noEmit` + измерение на тех же Test 1/Test 2/большом скрипте, отметка статуса здесь.
