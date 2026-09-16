# YouTube-pipeline — каталог замеченных ошибок и проблем

> Зафиксировано 2026-06-24 по логам тестовых прогонов (Tesla/NVIDIA short-тесты + большой
> 45-битовый pico-hydro прогон `run_8d4b198e`). Список для последующего разбора. НЕ план
> на немедленную правку — фиксация наблюдений. Severity: 🔴 риск/баг · 🟡 калибровка/качество
> · 🟢 внешнее/ожидаемое.

---

## A. Внешние сбои провайдеров (не наш код)

### A1 🔴 kie.ai (nano-banana) — `internal error` на генерации AI-картинок
- **Симптом:** `AI image gen failed (kie.ai nano-banana failed: internal error, please try again later.)`
- **Где:** `run_8d4b198e` Beat 30 (×2), Beat 32 (×2), ~20:57–20:59. Раньше (Beat 24/25, ~20:49–20:51) nano-banana работал (`match 90%`) → похоже на временный сбой провайдера, начавшийся ~20:57.
- **Риск:** AI — терминальный fallback. Если kie.ai не оживёт, AI-биты падают; при превышении `FAILURE_THRESHOLD_PERCENT` (дефолт 25%) **возможен abort всего прогона**. Особенно опасно на скриптах с большой долей AI/архивных битов.
- **Разобраться:** ретраи/бэкофф для kie.ai; запасной AI-провайдер (69labs/Grok) при устойчивом отказе nano-banana; не считать kie-сбой за «провал бита», если есть чем заменить.

### A2 🟢 Gemini 503 — планировщик визуальных запросов
- **Симптом:** `Gemini attempt N/5 failed (Gemini 503 … model is currently experiencing high …) — retrying`. Частит (почти каждый чанк в больших прогонах).
- **Где:** повсеместно (`run_8d4b198e` 20:17–20:19 — до 4 ретраев подряд; во всех тестах).
- **Последствие:** при полном выгорании 5 попыток чанк теряет `footage_kind`/`query_type` (см. C3). Лечится ретрай-лесенкой + Fix 1 (coarseFootageKind).
- **Разобраться:** в основном вне нашего контроля (capacity Google). Возможно — кэш/дешёвая модель для плана, или предобработка.
- **МИТИГИРОВАНО (2026-06-24):** лестница ретраев `requestPlanChunk` была одно-поколенческой (`2.5-flash`/`2.5-flash-lite` — оба падали при спайке 2.5 одновременно → 5/5 fail). Диверсифицирована через поколения (добавлены `gemini-2.0-flash`/`gemini-2.0-flash-lite` — отдельный пул). Корневой рычаг остаётся account-side: **free-tier ключ ловит 503 в разы чаще под нагрузкой → включить billing.** Также WI-7 footage-shaped `keywordsFrom` делает 503-fallback нетравматичным.

### A3 🟢 Gemini 503 — vision-скоринг (scoreAndPick / scoreLocalImage)
- **Симптом:** `scoring attempt N/3 failed (Gemini 503) — retrying` → `scoring failed after 3 attempts — lexical fallback scoring`.
- **Где:** `run_8d4b198e` Beat 8 (→ lexical → Pexels 68%), Beat 20 (→ lexical → AI), Beat 0/9 ретраи.
- **Последствие:** при выгорании — lexical fallback (по тексту, без картинки) → менее точный выбор; иногда занижает и роняет в сток/AI.
- **Разобраться:** приемлемо (graceful), но при массовых 503 качество отбора падает.

---

## B. YouTube-ретрив

### B1 🟡 Архивная augmentation `"… archival footage newsreel"` → `no-results` + лишний поиск
- **Симптом:** `WARN yt-dlp search [no-results] q="… archival footage newsreel"` затем bare-query тоже `[no-results]`.
- **Где:** `run_8d4b198e` Beat 18, 20, 21, 22, 28, 30, 31 (нишевые именованные субъекты: Lester Allan Pelton, Sir William Armstrong, Northumberland residence, hurdy gurdy).
- **Корень:** добавка «archival footage newsreel» переконстрейнивает и так редкий запрос → гарантированный ноль на первом проходе; bare-проход часто тоже пуст, т.к. субъект слишком нишевый (YouTube реально пусто).
- **Последствие:** лишний пустой search-проход на каждый такой бит (латентность) → затем сток/AI.
- **Разобраться:** смягчить augmentation (например, только «footage», без «newsreel»), или не делать augmentation для `query_type=entity` нишевых субъектов; для именованных исторических персон YouTube как источник почти бесполезен — сразу сток/архив-провайдеры.

### B2 🟡 Поиск возвращает правдоподобное-но-чужое видео
- **Симптом:** топ-результат не по теме; ловится скорером/вето, но жжёт кандидата.
- **Где:** Beat 31 «Tourists visit island off UK coast» для «Northumberland residence» `[20,20,0,0,0]`; ранее «Elon's SpaceX Tour - Offices» для Gigafactory; «Nvidia CUDA in 100 Seconds» (туториал) для «GPUs in parallel».
- **Корень:** ytsearch по нишевому/смешанному запросу; нет ранжирования «это b-roll, а не туториал/новость».
- **Разобраться:** ранжирование кандидатов по «b-roll-likeness» (P3); query-shaping (см. G1).

---

## C. Скоринг / логика приёмки (наша калибровка)

### C1 🟡 5-кадровая приёмка: knife-edge на пороге 72 — ровные клипы гибнут, рваные проходят
- **Симптом:** равномерно-приличный клип отклоняется, а «спайк» (2 идеальных + 3 слабых) принимается через rescue.
- **Доказательства (`run_8d4b198e`):**
  - REJECTED: Beat 10 `[80,70,70,70,80]` (passCount 2/5), Beat 14 `[60×5]`, Beat 17 cand1 `[0,39,39,70,39]`.
  - ACCEPTED (rescue/спайк): Beat 3 `[100,39,39,39,100]`, Beat 4 `[39,39,39,100,100]`, Beat 28 `[39,100,100,0,100]`.
  - Сравнение knife-edge: Beat 17 cand2 `[70,80,80,80,80]` ACCEPTED vs Beat 10 cand3 `[80,70,70,70,80]` REJECTED — решает, легли кадры в 70 или 80 (шум скорера).
- **Корень:** `consensus = majority ≥ threshold(72)` + `rescue = best≥95 && second≥45` калибровались под 3 кадра; на 5 кадрах rescue слишком мягкий (2 кадра тянут), а consensus слишком жёсткий к полосе 68–71.
- **Разобраться (приоритет №1 пост-ран):** приёмка на основе среднего/медианы (например, median ≥ threshold ИЛИ ≥40% кадров ≥ threshold И mean ≥ threshold); ужесточить rescue. Чинит оба перекоса разом.

### C2 🟡 B1-context не срабатывает на своём целевом кейсе
- **Симптом:** «правильная персона — неправильное место» проходит; модель возвращает `context_ok=true`.
- **Где:** Test 2 (ранее) «Elon's SpaceX Tour - Offices» для «Elon … Gigafactory interior» → ACCEPTED 100%.
- **Корень:** запрос смешал два визуала («Elon on stage» + «Gigafactory»); клип удовлетворяет половину; модель не флагает мисматч. Не чинится на скорере без риска ложных срабатываний.
- **Разобраться:** корень в планировщике (G1) — не склеивать две сущности в один запрос.

### C4 🟡 Жадный выбор «первый принятый побеждает» — нет best-of-N между кандидатами
- **Симптом:** между двумя YouTube-кандидатами система берёт ПЕРВЫЙ, прошедший порог, а не ЛУЧШИЙ. Второй кандидат вообще не скорится, если первый принят.
- **Механика:** `youtubeScoredFallback` — последовательный цикл по кандидатам; `if (accept) { rename → return }` на первом прошедшем. Сравнения кандидатов между собой НЕТ.
- **Пример (поставлен пользователем):**
  - cand1 `[0,0,100,100]` → `rescue` (best 100, second 100) → **ACCEPT** → return.
  - cand2 `[30,30,80,70]` → **не оценивается** (цикл уже вышел). Даже если бы оценился — под текущими правилами **REJECT** (passCount ≥72 = 1/4, нет consensus; best 80 < 95, нет rescue).
  - Перверсия: для проигрывания cand2 ЛУЧШЕ (min 30, нет мёртвых кадров), а cand1 наполовину «чёрный/не тот» (два кадра 0). Система берёт худший для показа клип.
- **Две причины, обе тянут к первому:** (1) жадность — нет best-of-N; (2) метрика приёмки (rescue) награждает ПИКИ, а не ПОЛ/консистентность (= C1).
- **Разобраться:** (1) метрика на основе floor/медианы/среднего со штрафом за dead-frames (0) — тогда `[30,30,80,70]` (min 30) обходит `[0,0,100,100]` (min 0); (2) опц. best-of-N: скорить N кандидатов, брать лучшего по этой метрике, а не первого прошедшего. Связано с **C1** (метрическая половина) — чинятся вместе.

### C3 🟡 Потеря `footage_kind`/`query_type` при полном выгорании Gemini-плана
- **Симптом:** при 5/5 провалах чанка беты теряют planner-поля → выпадают из YT_PREFER-роутинга.
- **Статус:** частично закрыто **Fix 1** (`coarseFootageKind(domain)`). НО см. E1 — domain шумит, и `history→archival` может мислейблить современный бит.

---

## D. Текст / качество (фикс T1/T2 работает, но с издержками)

### D1 🟡 Архив ↔ no-text: настоящая хроника режется text-вето
- **Симптом:** реальные newsreel с интертитрами/плашками → `textVeto=true`.
- **Где:** `run_8d4b198e` Beat 23 «1937 SWITZERLAND: WATER SPEED RECORDS … Newsreel» `[TEXT×5]`, «HD Stock Footage … 1953 Newsreel» `[TEXT×5]`; Beat 22 «Force Exerted by a Jet…» `[100,TEXT,TEXT,TEXT,TEXT]`.
- **Корень:** глобальное no-text вето (вариант A) бьёт по архиву, где титры — норма.
- **Разобраться:** footage_kind-gated вето (вариант C) — для `archival` терпеть интертитры; для `contemporary` давить как сейчас. (Нужно прокинуть `footageKind` в `scoreLocalImage`.)

### D2 🟢 Explainer/tutorial-темы text-насыщены → низкий YouTube-ratio + много циклов
- **Где:** весь pico-hydro прогон — DIY-туториалы с заголовками; масса `textVeto`, M1 перебирает по 2–3 кандидата.
- **Статус:** не баг — осознанный размен «чисто > YouTube». Но на таких темах ratio структурно ~50–56% (vs 100% на чистом Tesla/NVIDIA b-roll).

---

### D3 🟡 Современные product/demo/news-клипы часто с постоянными субтитрами → text-veto режет ВСЕХ кандидатов
- **Симптом:** даже официальные короткие ролики (Tesla Optimus demo, новости) идут с вшитыми подписями весь клип → все 3 кандидата text-vetoed → сток/архив.
- **Где:** `run_62ff3fbf` Beat 3 «Tesla Optimus robot walking» — cand1/2/3 все `reason=text` (вкл. официальный «Optimus Navigating Around | Tesla» `[TEXT×5]`) → упал на **archive 100%** (бит НЕ потерян).
- **Статус:** не баг — text-veto + best-of-N + сток/архив отрабатывают как задумано. Но на caption-насыщенном modern-контенте это потолок YouTube-доли. Рычаг (если нужно ВЫШЕ ratio ценой строгости): ослабить veto до «≥2 текстовых кадров» ИЛИ query-shaping к b-roll-каналам (WI-7 B/C). Сейчас оставляем строгим (цель «без текста»).

## E. Шум доменного классификатора (диагностика, но влияет на Fix 1)

### E1 🟡 `classifyDomain` мислейблит
- **Симптом:** диагностический `domain=` не сходится с темой.
- **Где:** «NVIDIA gaming … servers» → `domain=history`; «Jensen Huang keynote» → `domain=finance`; «Elon Musk … Gigafactory» → `domain=generic`.
- **Риск:** сам по себе диагностика, НО Fix 1 теперь читает domain → `coarseFootageKind(history)=archival`. При выгорании плана современный бит может получить `archival`-роутинг (augmentation+no-results, мимо контемпорари).
- **Разобраться:** уточнить ключевые слова, либо в Fix 1 маппить только высокоточные домены (history по году 18xx/19xx, а не по словам).

---

## F. Латентность

### F1 ✅ Большая стоимость на бит — повторный `ytsearch` устранён (WI-8)
- **Симптом:** ~1.5+ мин/бит; 45-битовый прогон → ~60–90 мин.
- **Слагаемые:** 5 кадров × до 3 кандидатов × скачивания + пустые архивные поиски (B1) + ретраи 503 (A2/A3) + повторный `ytsearch` на каждого кандидата (M1 не кэшировал поиск).
- **ЗАКРЫТО (WI-8):** `acquireYouTube` расщеплён на `searchYouTube` (1 поиск/бит) + `downloadYouTube` (per-candidate). best-of-N теперь качает из ОДНОГО ранкинга, не ре-серчит. На битах, исчерпавших 3 кандидата (run_3a0cedc3 Beat 0/2/5), это 3 поиска → 1.
- **Остаток (НЕ WI-8):** wall-clock всё ещё держат сами **скачивания** caption-насыщенных клипов, которые потом text-vetoed (см. D3 ниже) + пустые архивные поиски (B1). Это уже не про ре-серч, а про то, что мы качаем клипы, обречённые на text-вето.

---

## G. Планировщик / запросы

### G1 🟡 Narration-shaped и «склеенные» запросы
- **Симптом:** запрос смешивает две картинки или narration-сырьё.
- **Где:** «Elon Musk on stage Gigafactory interior» (две сущности); 503-fallback `keywordsFrom` → «machines becoming infrastructure layer modern intelligence».
- **Разобраться:** query-shaping (Fix 2 / P3) — отдельная картинка на бит; footage-shaped fallback вместо narration-keywords.

### G2 🟢 Стоковый пул без thumbnails → слабый отбор
- **Симптом:** `scored 6 candidates (0 with image) — best 39` → AI.
- **Где:** Beat 25. web/archive-картинки без превью → скорер судит по тексту → занижение.
- **Разобраться:** минор; можно подтягивать превью или штрафовать no-thumb меньше.

---

## Дополнение — финал `run_8d4b198e` (биты 31–44, прогон завершён)

**Итог прогона:** `FINAL SOURCE RATIO: planned_real=38 planned_ai=7 | actual_real=34 actual_ai=11 | fallbacks_real_to_ai=4 | failed_or_reused=0`. Прогон **дошёл до конца, abort не случился, ни один бит не потерян** (`failed_or_reused=0`). Значимая доля real-битов ушла в **Pexels**, а не YouTube (архивный блок + коллизии запросов ниже). Точного YouTube/stock-сплита в итоговой строке нет — она делит только real/ai.

### A1 (update) 🟢 kie.ai восстановился
Падения `internal error` на Beat 30/32 были **временными**: после ретраев AI-картинки сгенерились (Beat 32 @20:59, Beat 30 @21:01, далее 37/42/43 — ок). Abort по `FAILURE_THRESHOLD_PERCENT` не произошёл. Риск из A1 остаётся актуальным для случая устойчивого отказа, но в этом прогоне обошлось.

### A4 🟢 Pexels — `fetch failed` на скачивании
- **Симптом:** `pexels 90% failed to download (fetch failed) — trying next candidate` ×3.
- **Где:** Beat 44 (21:14–21:15) → после 3 неудач взял другой Pexels-кандидат (80%).
- **Статус:** обрабатывается (acquireReal перебирает кандидатов). Транзиентная сеть. Минор.

### B5 🟡 Очень короткие видео (≤~15с, Shorts/клипы) проходят duration-фильтр
- **Симптом:** 11-секундный ролик проходит `c.duration >= need && <= 3600` (need≈8с) → но это Short (вертикальный/текстовый) → почти всегда text-veto + трата слота кандидата.
- **Где:** `run_62ff3fbf` Beat 3 cand3 «Tesla optimus 2.5 gen walk human-like CRAZY 😲» `videoDurationSec=11`, segment 0-9s, `[TEXT×5]`.
- **Разобраться:** минимальный duration-floor (~20-30с, настройка) в candidate-фильтре `acquireYouTube` — отсекать Shorts/клипы ДО скачивания (экономит цикл + слот). Низкий риск.

### B3 🟡 Коллизии ключевых слов → поиск тянет ВООБЩЕ не по теме
Новый класс (хуже B2): одно слово запроса утягивает в чужой домен, все 3 кандидата мимо → сток.
- **Beat 41** «water intake **screen** on stream edge» → «You NEED this for your GAMING SETUP!», «Thermalright cooling industry», «My Biggest Issue With The iPhone Air» (по слову *screen* → мониторы/железо). Все `[0,0,0,0,TEXT]`.
- **Beat 44** «**leaves** sticks silt washing over grate» → «Disinfect Leaves for Reptile Habitats», «Leaf Transpiration Experiment», «Remove Leaves From Mulch» (по *leaves* → садоводство). `[0×5]`.
- **Корень:** ytsearch по generic-фразе без доменного якоря; нет «это про гидро/воду» контекста в запросе.
- **Разобраться:** query-shaping с доменным якорем (G1); ранжирование/負 отсев off-topic по заголовку.

### B4 🟡 Sound-effect / ambience-ролики = статичная текст-карточка + аудио
- **Симптом:** ролики «… [SOUND EFFECT]» — один кадр-надпись на весь клип → `[TEXT×5]` или `[0×5]`.
- **Где:** Beat 39 «Small Stream Flowing [SOUND EFFECT]» × три разных кандидата подряд → все вето/0 → сток.
- **Разобраться:** отсев по маркерам заголовка (`sound effect|white noise|sounds 24/7`) до скачивания — экономит 3 цикла.

### B1 (update) 🟡 augmentation re-runs НА КАЖДОГО кандидата
- **Уточнение:** «… archival footage newsreel» `[no-results]` логируется **повторно на каждом** candidate-ретрае (Beat 33 — 3× подряд; Beat 31, 30, 28, 34, 35). То есть пустой архивный поиск множится на число кандидатов → латентность ×3.

### C1 (reinforce) 🟡 rescue пропускает off-topic «спайк»-клипы
- **Beat 31 cand2** «Britain's deadliest garden | BBC» для «Northumberland private residence falling water power» → `[0,100,20,0,100]` → **ACCEPTED** (rescue: два 100 тянут, три кадра 0/20). Клип ~60% не по теме, принят. Это и C1 (rescue слишком мягкий при 5 кадрах), и косвенно C2 (контекст не проверен).
- **Beat 34** `[100,100,0,100,0]` ACCEPTED (3/5). Ещё пример.

### Наблюдение (не ошибка) — корректная работа
- Beat 42 `routing to AI (shouldPreferAi: keyword="surface tension")` — химия → AI, правильно.
- Beat 39 `dropped negation clause ("… no large dam" → "small stream flowing")` — снятие негатива, правильно.

---

---

## Дополнение — `run_3a0cedc3` (6-битовый AI/data-center прогон, WI-8 live-валидация)

**Итог:** `FINAL SOURCE RATIO: planned_real=5 planned_ai=1 | actual_real=5 actual_ai=1 | fallbacks_real_to_ai=0 | failed_or_reused=0`. Прогон чистый, abort нет, ни один бит не потерян. Все источники качественные.

### F1 (validate) ✅ WI-8 подтверждён в бою
best-of-N ходит по одному ранкингу: Beat 0 cand1/2/3 = три РАЗНЫХ видео (QtVRLBbU2XU → TRBLavoa1Ls → uH3VavuJyY0), Beat 5 — три разных, без повторного ytsearch. 0 фейлов, 0 ре-серчей на кандидата. *(Примечание: успешный `searchYouTube` не логирует строку — для точного замера «1 поиск/бит» стоило бы добавить debug-лог старта поиска; структурно гарантировано вызовом до цикла.)*

### D3 (reinforce) 🟡 text-veto режет YouTube на современном AI-контенте — потолок ratio ~40%
**Это headline-находка прогона.** Из 5 real-битов **3 потеряли ВСЕ 3 YouTube-кандидата на text-вето** (Beat 0/2/5) → ушли в Pexels (чисто, 88–95%). YouTube взял только Beat 1 (86) и Beat 3 (95). **YouTube-ratio = 2/5 (40%)** при цели 60–80% для contemporary-generic.
- **Ключевой кейс — одно-кадровое вето на идеальном клипе:** Beat 2 cand1 «Ultimate AI Powerhouse Rack – 20x GPUs» `[90, TEXT, 90, 90, 90]` → 4 чистых кадра 90, ОДИН с текстом → весь отличный клип vetoed. Также Beat 2 cand3 `[100,100,TEXT,90,TEXT]`, Beat 0 cand2 `[TEXT,TEXT,TEXT,TEXT,100]`, Beat 5 cand3 `[100,TEXT,TEXT,TEXT,TEXT]`.
- **Корень/тензия:** двоичное вето (любой prominent-text кадр → дисквалификация) против явного требования пользователя «никакого текста». На modern AI/data-center/explainer контенте субтитры/нижние трети — норма → почти всё vetoed.
- **Размен (НЕ чиним без решения пользователя):** (a) **оставить строго** — чисто, но YT-ratio ~40% на таких темах, Pexels добирает чистым (текущее, корректное по «clean > YouTube»); (b) ослабить вето до «≥2 текстовых кадров» — поднимет ratio, но рискует пропустить кадры с текстом (нарушение «без текста»); (c) сегмент-ретрай: при text-вето качать ДРУГОЕ окно того же видео в поисках чистого участка (сложнее, +латентность). **Решение за пользователем.**
- **ВЫБРАНО (c) → WI-9 ✅ (2026-06-25, default `YT_SEGMENT_RETRIES=1`):** при text-вето релевантного клипа (`mean(scored)≥clipBar`, `≥2` не-текстовых кадра, `!deadVeto`) качаем другое окно того же видео (`nextSegmentStart`, non-overlapping) и пере-скорим. text-вето/скорер НЕ ослаблены — ловим именно «хороший клип, плохое окно» (эталон Beat 2 `[90,TEXT,90,90,90]`). Триггер узкий: `[TEXT×5]`/off-topic ретрай не запускают. Live hit-rate ожидается; при успехе поднять до 2.

### Косметика 🟢 лог «entity → YouTube-first» жёстко зашит даже для generic-битов
- **Симптом:** `Beat 0: entity → YouTube-first` печатается для Beat 0/2/3/5, хотя у них `query_type=generic` (YouTube-first сработал по `YT_PREFER`+contemporary, не по entity). Строка лога захардкожена «entity →».
- **Где:** `visual-source.ts` ветка `if (youtubeFirst)` в `acquireReal`. Поведение верное, врёт только текст лога.
- **Разобраться:** минор — заменить на нейтральное «→ YouTube-first» или указать реальную причину (`YT_PREFER`/entity). Низкий приоритет.

---

---

## Дополнение — `run_3d19dcf2` (5-битовый NVIDIA/datacenter прогон, WI-9 live-валидация)

**Итог:** `actual_real=4 ai=1 | fallbacks_real_to_ai=0 | failed_or_reused=0`. Чисто, ничего не потеряно. YouTube взял Beat 0 (89) и Beat 1 (78) → **YT-ratio 2/4 (50%)**, Beat 2/4 → Pexels (90/85), Beat 3 → AI (план).

### WI-9 (validate) ✅ гейтинг точный, но hit-rate этого прогона 0/1 — текст ОКАЗАЛСЯ ПОСТОЯННЫМ
- **Сработал 1 раз, корректно:** Beat 0 cand1 «How NVIDIA GPUs Are Made | THE MAKING» окно 200s `[TEXT, 80, 90, 80, 90]` (mean не-текстовых 85 ≥ 64, ≥2 кадра, !deadVeto) → триггер `segment-retry window 1/1 @ 286s`.
- **Ретрай НЕ дал чистого окна:** окно 286s `[TEXT, 90, 90, 90, 90]` — снова текст в кадре 0. Бит всё равно ушёл на YouTube через **другое видео** (cand2 «NVIDIA HGX H100» `[70,85,100,100,90]` → 89 ACCEPTED). WI-9 не навредил, стоил ~1 лишнее скачивание (~80с).
- **Корень нуля hit-rate:** у брендового explainer-видео текст **ПОСТОЯННЫЙ** (нижняя треть/лого/«THE MAKING» весь ролик) → другое окно того же видео = тот же текст в той же позиции кадра. **WI-9 спасает только ТРАНЗИЕНТНЫЙ текст** (подпись на части ролика, как эталон прошлого прогона Beat 2 `[90,TEXT,90,90,90]`); структурный брендинг им не обойти. Этот прогон попал на видео с постоянным текстом → ретрай впустую.
- **Гейтинг подтверждён ПО ВСЕМ кейсам (узкий, как задумано):**
  - Beat 4 cand1 `[TEXT,TEXT,60,TEXT,TEXT]` — `scored=[60]` length 1 < 2 → ретрай НЕ запущен ✓
  - Beat 4 cand3 `[39,39,100,TEXT,TEXT]` — `mean(scored)=59.3 < 64` → не релевантен → НЕ запущен ✓
  - Beat 2 cand3 `[TEXT,TEXT,TEXT,TEXT,100]` — `scored=[100]` length 1 < 2 → НЕ запущен ✓
  - `[TEXT×5]` (Beat 1/2 cand1) — `scored` пуст → НЕ запущен ✓
- **Вывод:** механика и гейтинг верны; раздувать `YT_SEGMENT_RETRIES` до 2 **смысла нет на брендовом контенте** (постоянный текст никуда не денется). Истинный hit-rate WI-9 надо мерить на прогоне с ТРАНЗИЕНТНЫМ текстом (этот его не содержал). Реальный рычаг для брендовых explainer-роликов — query-shaping к b-roll-каналам (WI-7 B/C, отложено) либо принять 50% и добирать чистым Pexels.

### F1 (validate) ✅ WI-8 снова чисто
Каждый бит — один `searchYouTube`, best-of-N качает разные видео из одного ранкинга (Beat 4: RBmOgQi4Fr0 → d3L2uPuxOxU → LMxemZtQ0LI). 0 ре-серчей, 0 фейлов скачивания.

---

---

## Дополнение — `run_ba18fccb` (9-битовый Tesla-прогон, WI-9 первый HIT на транзиентном тексте)

**Итог:** `actual_real=8 ai=1 | fallbacks_real_to_ai=0 | failed_or_reused=0`. **YouTube-ratio 5/8 (62.5%)** — лучший из замеров (40% → 50% → 62.5%). Биты 0/3/5/6/7 → YouTube; 1/2/4 → Pexels; 8 → AI (план).

### WI-9 (validate) ✅ ПЕРВЫЙ HIT — сегмент-ретрай спас бит для YouTube
- **Сработал 4 раза, 1 успех (hit-rate 1/4), +1 бит на YouTube:**
  - **Beat 5 cand3 «Inside Tesla's Factories»** окно 22s `[TEXT,90,90,90,80]` (mean 87.5, 4 кадра) → retry @419s `[90,60,85,90,80]` → **clipScore 81 ACCEPTED ✓**. Без WI-9 Beat 5 исчерпал бы всех кандидатов → сток. **Ретрай прямо спас бит** (62.5% вместо 50%).
  - Промахи: Beat 2 cand1 `[TEXT,70,80,TEXT,TEXT]`→retry@49s `[TEXT×5]`; Beat 4 cand1 `[TEXT,70,TEXT,60,TEXT]`→retry@245s `[20,0,20,39,0]` (dead); Beat 5 cand1 `[TEXT,TEXT,90,95,90]`→retry@42s `[90,TEXT,TEXT,TEXT,90]`.
- **Гейтинг снова точный:** Beat 5 cand2 `[90,TEXT×4]` (1 кадр<2)→пропуск; Beat 6 cand2 `[TEXT,39,39,TEXT,TEXT]` (mean 39<64)→пропуск; Beat 6 cand1 dead-veto (reason≠text)→пропуск; `[TEXT×5]`→пропуск. ✓
- **Вывод:** на транзиентном тексте WI-9 работает и окупается (1 бит/прогон при retries=1). Кандидат на **retries=2**: у Beat 5 успех пришёл с одного окна cand3 — второе окно дало бы ещё шанс там, где первое промахнулось (Beat 2/4/5cand1). Размен — латентность.

### НОВОЕ наблюдение 🟡 chapter-localize (YT_SEGMENT) сажает старт на КАРТОЧКУ ГЛАВЫ → frame-0 текст
Сильная закономерность: chapter-localized старты дают текст в кадре 0 непропорционально часто (Beat 2/4/5 cand с chapter-стартом → `[TEXT,…]`). Эталон: Beat 5 cand3 chapter-старт 22s («giga-casting»@20s) → `[TEXT,…]`, а blind-retry @419s (вне границы главы) → чисто `[90,60,85,90,80]`. **Корень:** начало главы = титульная плашка с названием → frame-0 ловит текст. **Рычаг (будущее, не сейчас):** смещать chapter-localized старт на +N сек мимо титра, ИЛИ не chapter-localize для contemporary (фича задумывалась для длинных/архивных). Сейчас WI-9 это частично компенсирует.

### Риск 🟢 ретрай на «supercut»/компиляции может попасть на DEAD/чужое окно
Beat 4 cand1 «Factory Robots… supercut» retry @245s → `[20,0,20,39,0]` dead-veto (другая тема компиляции). Корректно отбраковано, но 1 скачивание впустую. На многотемных компиляциях разные окна = разные темы. Минор.

### Косметика 🟢 округлённый clipScore в логе путает с «below-bar»
Beat 0 cand1 `[60,60,80,80,39]` → mean 63.8 → лог «clipScore 64» (Math.round), но reason=below-bar (63.8<64). Выглядит как «64<64». Минор — показывать 1 знак после запятой.

---

---

## Дополнение — `run_f5ca3061` (8-битовый NVIDIA/Tesla/datacenter, WI-10 частичная валидация)

**Итог:** `actual_real=7 ai=1 | fallbacks=0 | failed=0`. YouTube взял Beat 4 (94) и Beat 7 (92); остальные real → Pexels (85–90). **YT-ratio 2/7 (~29%)** — но прогон НЕ репрезентативен (см. ниже).

### ⚠️ Рычаг 1 (deep sweep) НЕ активировался — сид DB перекрыл новый дефолт (известный гейтча)
В логах везде `candidate 1/3 … 3/3`, `exhausted up to 3 candidate(s)` → `maxCandidates=3`, не 6. Причина: `YT_CANDIDATES="3"` сидирован в БД с прошлых запусков; `getSetting` (DB-first) игнорит новый код-дефолт `"6"` (см. [[settings-db-seed-shadows-env]]). **Исправлено:** `UPDATE settings SET value='6'` (2026-06-25). Этот прогон скорил только 3 кандидата → биты, которым нужен был чистый кандидат на позиции 4–6, упали в Pexels рано. Ratio 29% — артефакт, не реальный результат WI-10.

### ✅ Рычаг 2 (b-roll shaping) РАБОТАЕТ — прямое доказательство
- augmentation сработал на всех contemporary-битах (`b-roll-augmented query "… cinematic b roll"`).
- **Тиринг вытащил чистые b-roll/stock-источники вперёд и они победили:**
  - **Beat 7 cand1 «Data Center Beauty Shots (B-Roll)»** `[100,90,90,90,90]` → **92, принят на позиции 1/3** (b-roll-тир поднял его в топ).
  - **Beat 4 cand3 «Data Center. Stock Footage»** `[100,90,90,100,90]` → **94**.
  Это ровно тот эффект, ради которого делали Рычаг 2 — clean-by-construction источники.

### Минор 🟢 «stock footage»-маркер ловит watermark-превью стоков
Beat 4 cand1 «Stock Footage - Server Room … | VideoHive» `[TEXT×5]` — превью стока с водяным знаком/текстом. `YT_BROLL` поднял его (маркер «stock footage»), text-veto корректно отбраковал. Рычаг (если станет шумно): даунранк `videohive|shutterstock|getty|istock|preview` watermark-превью. Пока минор.

### Минор 🟢 augmentation переконстрейнивает длинные запросы
Beat 1 «modern data center GPUs processing workloads **cinematic b roll**» → `[no-results]` → bare-query fallback отработал. Ожидаемо, потерь нет (теряем лишь b-roll-биас на этих битах).

**Вывод:** WI-10 наполовину провалидирован — Рычаг 2 явно работает (b-roll победил там, где появился), Рычаг 1 был выключен сидом и теперь разблокирован. **Нужен перепрогон с `YT_CANDIDATES=6`** для честного замера ratio.

---

---

## Дополнение — `run_5cadd0ca` (8-битовый, ЧЕСТНЫЙ замер WI-10: YT_CANDIDATES=6 активен)

**Итог:** plan real=8 ai=0. YouTube взял Beat 3/4/6/7; Beat 0/1/2/5 → Pexels. **YT-ratio ≈4/8 (50%)** (Beat 5 — Pexels, лог обрезан). Латентность ~3 мин/бит (6 кандидатов; пользователь принял).

### ✅ Рычаг 1 (deep sweep) ПРОВЕРЕН — спас бит, который при cap=3 был бы потерян
- **Beat 4 победил на candidate 6/6** «Giga Berlin Fly Through 2.0 | Tesla» `[90,80,80,100,100]`→90. При старом cap=3 ушёл бы в Pexels. Глубокий sweep напрямую сохранил бит.
- Beat 3 cand3/6 «Flying Through Giga Berlin» `[90×5]`→90; Beat 6 cand2/6; Beat 7 cand1/6 «FreiLacke Corporate Movie» `[100,100,100,60,100]`→92.

### ✅ Рычаг 2 (b-roll shaping) ПРОВЕРЕН — победители именно clean-by-construction
Все 4 YouTube-выигрыша — аэро/flythrough/corporate b-roll («Giga Berlin Fly Through», «Flying Through Giga Berlin», corporate movie). Тиринг+augmentation вытащили их.

### 🟡 Потолок 50% на этом скрипте — два СТРУКТУРНЫХ кейса, которые 1+2 не берут
1. **Persistent-caption но РЕЛЕВАНТНЫЙ** (→ кандидат на Рычаг 3 crop): Beat 1 cand1 «Inside a NEW AI Cluster — Tour with NVIDIA B200» `[90,95,TEXT,TEXT,90]` clipScore 92 — отличный clip, потерян ТОЛЬКО из-за субтитров; WI-9-ретрай @182s тоже текст. Это ровно тот случай, который **crop-recovery вырезал бы** (low-third подпись на 90/95-релевантном кадре).
2. **Mediocre single-channel пул** (1+2+3 НЕ помогут): Beat 2 «Tesla Gigafactories robots assemble batteries» — ВСЕ 6 кандидатов = клипы одной vlog-серии «Tesla Gigafactory Austin 4K Day NNN» `[40×5]`/dead. Глубже sweep = больше того же канала; b-roll-augmentation не разбавил. Это relevance/source-quality проблема, не текст. Лечится только query-shaping в планировщике (WI-7 B) или принятием Pexels.

### Наблюдение 🟢 «4K Day NNN» vlog-серии засоряют entity-пул Tesla-factory запросов
Один пролифик-канал ежедневных flyover-влогов (date/text-оверлеи, средняя релевантность 40) занимает почти весь топ ytsearch по «Tesla Gigafactory…». Кандидат на даунранк по паттерну заголовка `\b4K Day \d+\b` или `Day \d+ -` (как B5/B-серия). Минор-калибровка.

**Вывод:** WI-10 (1+2) даёт измеримый прирост и оба рычага доказаны, но потолок на caption/vlog-тяжёлом скрипте ~50%. Чтобы пробить выше — **Рычаг 3 (crop-recovery, WI-11)** для кейса №1 (релевантные клипы, потерянные только из-за подписей). Кейс №2 — отдельная история (планировщик).

---

---

## Дополнение — `run_35bb3e28` (8-битовый Tesla-factory, валидация WI-12 + WI-10 на b-roll-rich скрипте)

### ✅ WI-12 ПОДТВЕРЖДЁН — дубликата НЕТ
Все принятые YouTube-видео уникальны по `videoId`, несмотря на параллельные биты:
Beat 0 `7-4yOx1CnXE` (79) · Beat 1 `blW-Fa4a10g` (89) · Beat 2 `QlHcsKTrREY` (84) · Beat 3 `CnbUhHTWqYc` (91) · Beat 5 `zjBsYTeHBCk` (92) · Beat 6 `P7fi4hP_y80` (95) · Beat 7 `PXO4WFgBS9g` (79).
В прошлом прогоне `blW-Fa4a10g` стоял на Beat 4 И Beat 6; теперь — только на Beat 1. Beat 0/1 — РАЗНЫЕ облёты Giga Berlin (`7-4yOx1CnXE` vs `blW-Fa4a10g`), не дубликат. Гонка под параллелизмом закрыта.

### ✅ WI-10 РАСКРЫЛСЯ на b-roll-rich контенте — ratio ~75–87% (6–7 из 8)
Скрипт с реальной b-roll-доступностью → shaping вытащил и победили именно clean-by-construction:
«Industrial Robot (NO copyright 4K footage)» 92, «BMW Car Factory ROBOTS» 95, «Tesla B-roll: Gigafactory 3 Shanghai» 79, «Flying Through Giga Berlin» 79, «Giga Berlin Fly Through 2.0» 89, «Tesla GigaCasting with Giga Press» 84. Deep sweep тоже сработал (Beat 1 победил на cand 6/6 `[90,90,90,90,85]`→89; Beat 3 на cand6 91). **Это потолок WI-10 на хорошем скрипте — против 50% на explainer/vlog-тяжёлом.**

### 🟡 Beat 4 — провал по РЕЛЕВАНТНОСТИ запроса, не по тексту
«Battery production lines scaling energy output» — все 6 кандидатов off-topic (BESS, DW renewables doc, «World's Largest Lemon Battery», «Solar Panel Breakthrough», physics EMI). Слово «energy output» утянуло в энергетику/солар/физику (класс B3-коллизий). Лечится query-shaping в планировщике, не text/crop. Ушёл в сток (хвост лога обрезан).

**Вывод:** WI-12 закрыл дубликат; WI-10 на b-roll-доступном контенте даёт ~75–87% (показал реальный потолок). Остаток — (1) crop для caption-релевантных клипов (WI-11), (2) query-коллизии типа Beat 4 (планировщик).

---

---

## Дополнение — `run_35bfc227` (11-битовый manufacturing/AI, валидация WI-13)

**Итог:** `actual_real=10 ai=1 | fallbacks=0 | failed=0`. YouTube: Beat 0/1/2/6/7/9; Pexels: 3/4/5/8; AI: 10. **YT-ratio 6/10 (60%)**. Латентность ~45 мин (deep sweep 6 кандидатов × 11 битов ≈ 4 мин/бит).

### ✅ WI-13 ПОДТВЕРЖДЁН — сработал чисто, без ложных срабатываний
- Единственный триггер: `Beat 2: query-trim "robotics systems manufacturing optimization" → "robotics systems manufacturing"` (срезал «optimization»). Бит → YouTube cand6 «Free Stock Video | Tire Balancing Automation» 87. Чисто, без вреда.
- **Мало срабатываний (1/11)** — потому что Gemini в этом прогоне выдал уже чистые запросы («advanced manufacturing factory floor robots», «data center server racks», «semiconductor fabrication plant cleanroom»), без абстрактных хвостов. Это норма: WI-13 узкий и срабатывает только когда есть что резать. Beat-4-тип («scaling energy output») не повторился.

### ✅ WI-12 держится · b-roll shaping снова побеждает
Все принятые videoId уникальны (Beat 6 взял Intel Ireland Dec-2022, cand2 был Intel Ireland Mar-2023 — разные видео, не дубль). Победители — «High-Tech Manufacturing 4K Cinematic Factory» (91), «Microsoft MASSIVE data center» (100), «Flying Through Giga Berlin» (90), «Intel Ireland drone footage» (90). Gemini 503 на Beat 3 скоринге — graceful recovery.

### 🟡 НОВОЕ — Beat 8 «company logos» = запрос за ГРАФИКОЙ/текстом (планировщик)
«NVIDIA Tesla TSMC company logos» — все 6 кандидатов финанс/news/comparison с текстом (stock picks, market-cap comparison, «TSMC Arizona Nightmare») → exhausted → Pexels 85. Корень: слово **«logos»** просит экранную графику/лого, что по определению = текст/монтаж → text-veto всё режет. Это класс «non-b-roll-термин в запросе» (родственно полисемии). Не WI-13 (нет в abstract-списке). Кандидат для будущего query-shaping: запрет терминов-графики («logos», «logo», «comparison», «chart») в footage-запросе. Минор.

### 🟢 Beat 5 структурно непобедим для YouTube
«thousands of GPUs operating in parallel» — субъект существует на YouTube только как лекции/explainer (Scaling LLM Training, CUDA in 100 Seconds, GPU vs CPU) → весь пул с текстом → Pexels 90. D2-класс, не query/text-проблема.

**Вывод:** WI-13 корректен (1 чистый триггер, 0 ложных). Остаток ratio (40%) — структурные пулы (Beat 5 explainer-only, Beat 8 «logos»-графика, Beat 3/4 caption-тяжёлые). Латентность ~4 мин/бит — цена deep sweep.

---

---

## Дополнение — `run_8913aac0` (9-битовый, валидация WI-11 crop-recovery)

**Итог:** `actual_real=7 ai=2 | fallbacks_real_to_ai=1 | failed_or_reused=0`. YouTube: Beat 2/4/5/7; Pexels: 0/3/6; AI: 1 (фолбэк) + 8 (план). **YT-ratio 4/8 (50%)**.

### ⚠️ WI-11 crop-recovery: сработал 1 раз, 0 успехов — но СТРАХОВКА СРАБОТАЛА (брака нет)
- Единственный триггер: `Beat 3: crop-recovery region=upper → re-score [TEXT,TEXT,TEXT,TEXT,TEXT] clipScore 0 (acceptable=false)` на клипе «Can AI Finally Sound Emotional?» (YouTuber, w1 был `[100,TEXT,100,TEXT,TEXT]`).
- **Что пошло не так:** `detectTextRegion` по ОДНОМУ среднему кадру вернул `upper`, но текст на деле был center/scattered. Кроп верхней полосы + зум → оставшийся текст стал КРУПНЕЕ → пере-скор `[TEXT×5]` → **корректно отбракован**. Output не пострадал (бит → Pexels 88), но цикл потрачен.
- **Корень №1 (одно-кадровый region-probe ненадёжен):** когда текст «гуляет» по клипу, проба на одном кадре мислейблит регион. Рычаг: детект региона на 2-3 ТЕКСТОВЫХ кадрах + согласие; ИЛИ крутить только если re-score реально чище (страховка и так это даёт, но кроп тратится впустую).
- **Корень №2 (crop затенён segment-retry):** crop запускается на ПОСЛЕДНЕМ окне после ретраев. Если retry заменил релевантно-текстовое окно на below-bar/dead — идеальный кроп-кандидат потерян. Пример: Beat 0 cand3 `[TEXT,60,90,60,90]` (mean 75, отличная цель для кропа) → segment-retry дал w1 `[80,90,40,60,20]` below-bar → crop не запустился. Рычаг: помнить ЛУЧШЕЕ релевантно-текстовое окно и кропать ЕГО, если retry не вытянул.
- **Вывод:** механика safe (re-score-gate работает, брак не проходит), но реальный recovery=0 из-за (1) и (2). Чтобы crop начал спасать — нужна устойчивость region-детекта + не терять лучшее окно. Оба — отдельные доработки (не утверждены).

### 🟡 Beat 1 → AI фолбэк (структурно): «keynote speech» = talking-head
«Jensen Huang delivering keynote speech» — все кандидаты keynote-tips/talking-head/презентации → NON-B-ROLL + text → exhausted, Pexels best 39 → **routing to AI**. Корень: субъект = человек, говорящий в кадр, = не b-roll по определению. Класс «person-speaking запрос» — родственно Beat 8 «logos». Лечится только query-shaping в планировщике (не crop/text).

### ✅ WI-13 снова чисто
`Beat 0: query-trim "NVIDIA gaming company, AI revolution" → "NVIDIA gaming company, AI"` (срезал «revolution»). Корректно.

---

---

## Дополнение — `run_f345a917` (10-битовый, валидация WI-11a)

**Итог:** `actual_real=8 ai=2 | fallbacks_real_to_ai=1 | failed_or_reused=0`. YouTube: Beat 2/5/6/7; Pexels: 0/3/4/9; AI: 1 (фолбэк) + 8 (план). **YT-ratio 4/9 (44%)**.

### ✅ WI-11a РАБОТАЕТ как задумано — строгий консенсус убрал вредные кропы
Crop сработал 2 раза, **оба корректно ПРОПУЩЕНЫ** (раньше тут был crop-and-worsen):
- `Beat 1: crop-recovery skipped (region consensus [scattered,scattered,scattered])` — keynote-клип, текст по всему кадру → skip ✓
- `Beat 1: crop-recovery skipped (region consensus [full])` — текст-карточка → skip ✓
- **Доработка 2 подтверждена:** crop бежал на ДЕРЖАННОМ лучшем окне (cand2 `[TEXT,90,85,TEXT,TEXT]` mean 87.5), НЕ на последнем (w1 `[TEXT,TEXT,90,TEXT,TEXT]`, не релевантном). Механика «лучшее окно» работает.

### ⚠️ Но crop по-прежнему 0 успешных recovery за 2 прогона — его НИША не появляется
Релевантно-текстовые клипы на AI/keynote/explainer-контенте имеют текст **scattered/full** (слайды, нижние трети + титры), а НЕ чистую одиночную полосу субтитров. Crop спасает только последнее (lower/upper strip), и такого тут просто нет. WI-11a корректен и безопасен, но применим редко на этом типе контента.

### 🟡 ГЛАВНОЕ: оставшиеся потери — это QUERY-коллизии + структура, НЕ текст
Доминирующая причина провалов сместилась с «текст на хорошем футаже» на «тянем НЕ ТО видео»:
- **Beat 3** «Rows of servers processing data for **large language models**» → «OLAP vs OLTP», «ETL tutorial», «vibe coding», «n8n automation» — БД/кодинг-лекции, не серверный b-roll. Все text.
- **Beat 4** «Data center cooling… **monitoring screens**» → «MSI Afterburner FPS overlay», «Silverado features», chiller-анимации. «screens» → гейминг-оверлеи (B3-полисемия, как старое «screen»).
- **Beat 1** «Jensen Huang presenting… on stage» → keynote/talking-head → AI-фолбэк (структурно, как прошлый прогон; «person-presenting» класс, как «logos»).
- Это **планировщик** (query-shaping/доменный якорь), а не text/crop. WI-13 закрыл «абстрактный хвост», но полисемию («screens»/«large language models») и «person-presenting» (keynote/logos) — нет.

**Вывод:** WI-11a — корректное, безопасное завершение текст-ветки (вредные кропы устранены). Но потолок на AI/datacenter-скриптах (~44-50%) теперь держат НЕ текст, а **query-релевантность** (тянем чужие видео) и структурные субъекты (keynote/logos). Следующий реальный рычаг — query-shaping в планировщике (полисемия-якорь + детект «person-presenting/graphics» запросов → AI/сток сразу).

---

## Сводка приоритетов (для будущего разбора)
1. **C1 + C4** — переработка приёмки: метрика на floor/медиане/среднем (штраф за dead-frames) + best-of-N выбор лучшего кандидата вместо первого прошедшего. Самый ценный фикс качества — чинит и knife-edge, и off-topic-спайки, и «первый вместо лучшего».
2. **A1** — устойчивость к падению kie.ai (риск abort).
3. **D1 + B1** — архивный путь: footage_kind-gated text-вето + смягчить «newsreel»-augmentation.
4. **G1** — query-shaping в планировщике (закрывает C2 и часть B2).
5. **F1/M3** — латентность (не ре-серчить на каждого кандидата).
6. **E1** — точность domain для Fix 1.
