# Веб-окружение Джарвиса — редизайн (AX-Ref)

> Источник: многоагентная панель проектирования (25 агентов: 4 разбора кода + 4 ресёрча SOTA
> веб-агентов + 4 независимых архитектуры + 12 судей + синтез). Победивший дизайн — **RefGrid**
> (ref-реестр вместо CSS-селекторов, 6.7/10); синтез привил `browser_batch`, ранжированный
> fused-observe и per-host рецепты-данные.
>
> **Валидация владельца-инженера (не агентов):** несущее допущение проверено вручную —
> ISOLATED-world из `chrome.scripting.executeScript` в MV3 персистентен per (расширение, фрейм,
> документ): `globalThis.__jarvisRefs` виден между вызовами `executeScript` и между LLM-раундами,
> умирает на навигации вместе с документом. Значит ref-реестр даёт адресацию по идентичности с
> нулевым новым footprint и честным авто-протуханием. Подтверждены и две находки: мёртвый `break`
> в `selFor:272` (недостижим) и расхождение кода/дока на `browser.ts:282`.

> **СТАТУС РЕАЛИЗАЦИИ (2026-07-15): реализовано за флагом `JARVIS_BROWSER_REF` (деф OFF).** Сделаны Фазы
> 0-4: ref-реестр + ref-адресация (nonce→MAIN клик / ISOLATED для type/seek/scroll/enter) + state в снимке
> + selFor-фикс, `browser_batch` (`tabBatch`), ранжированный observed (STRONG/WEAK/коммит), гейт Яндекс-
> хардкода на `!refMode`, per-host рецепты (`memory/site-recipes.ts`, seed + recall-хинт) + переписанные
> сид-навыки. Тесты: сервер 1301, клиент 234, extension esbuild+node --check — зелёные.
> **Отклонения от дизайна (всплыли при реализации):** (1) `modules/ax.js` как ИМПОРТИРУЕМЫЙ модуль НЕ годится
> — `chrome.scripting.executeScript({func})` сериализует функцию БЕЗ замыканий, page-инжекторы обязаны быть
> self-contained; поэтому axName/stateOf/anchorFor — ИНЛАЙН в `inspectPageInPage`. (2) `browser_run{script}`
> отвергнут ещё в дизайне (MV3 CSP). (3) Один флаг `JARVIS_BROWSER_REF` (не два) — ref+batch+рецепты включаются
> вместе (owner смокает разом). (4) АВТО-ЗАПИСЬ рецепта из успешного прохода (upsert learned) НЕ включена —
> per-act демоут был бы неверен (один autoplay-блок ≠ «рецепт плохой»), нужен loop-хук/distiller; API стора
> (`upsert/reinforce/demote`) готов под этот follow-up. (5) navFallback-движок в расширении НЕ строился —
> знание навигации приходит рецептом-хинтом модели (проще и общее, как и задумано в §7 replay-gate).
> **Осталось владельцу:** живой смоук в реальном Chrome (flip флага + reload расширения + сайт с iframe/
> shadow/списками/логин-формой; регресс-гейт на Я.Музыке ПЕРЕД дефолт-включением) — `node --check` ref-реестр/
> nonce-мост/batch не ловит.
>
> **АДВЕРС-РЕВЬЮ (6 линз + верификаторы; 7 находок CONFIRMED — ВСЕ закрыты; верификаторы упали по лимиту
> сессии → адъюдицировано мной вручную, а не по пустому `confirmed`):** #1 коммит `enter:"true"` строкой
> (расширение постит по truthy) → now `r.submitted===true` авторитетен; #2 seed-дубль www.youtube.com
> затирал полный youtube.com → убран; #4 (HIGH) ref play/pause ставил observed при autoplay/чужом медиа →
> now только при совпадении с намерением, иначе честный autoplayBlocked; #5 стейл params.frameId + top-ref →
> резолв в чужом фрейме (gen не глобален) → фрейм строго из ref; #6 page-controlled value в доверенном теле →
> в `<untrusted_content>` с sani; #3/#7 сид-навыки учили ref/batch как основной путь при OFF-флаге →
> формулировки условны. Регресс-тесты на #1/#6 добавлены (сервер 1302).

**Механизм: AX-Ref — реестр элементов по идентичности (window-stashed, on-demand) + `browser_batch` + ранжированный fused-observe + per-host рецепты-данные.**

Синтез берёт за основу победивший **RefGrid**, но реализует реестр как window-stashed map в существующем on-demand isolated-world (БЕЗ `registerContentScripts`), прививает `browser_batch` (сжиматель раундов), ранжирование сигналов fused-observe по достоверности (закрытие «honesty landmine»), hostname-keyed рецепты, и явно отвергает нереализуемый `browser_run{script}` (MV3 CSP блокирует eval модель-авторского JS).

---

## 1. Диагноз (почему тупит сейчас)

Корень: **инспектор УЖЕ generic, а актуатор его не использует по-настоящему.** `inspectPageInPage` (`background.js:227`) отдаёт устойчивые селекторы, обходит shadow DOM (`collectDeep:280`, `selForDeep:295`) и iframe. Но `browser_act` адресуется `selector`/`text`, а `idx` (`:322`) — просто порядковый номер, ни на чём не резолвимый. Каждое действие ПЕРЕ-резолвит хрупкий путь. Отсюда пять поломок:

**1.1. Хрупкая адресация → лишние раунды.** `selFor:261-276` при отсутствии id/data-*/aria падает в неанкорённый `:nth-of-type` глубиной 4. `break` на `:272` — **мёртвый код** (`seg` в цикле всегда `tag`/`tag:nth-of-type`, никогда не содержит `#`/атрибут), так что цепочка не якорится к стабильному предку. `querySelector` берёт ПЕРВОЕ совпадение → на списке одинаковых карточек клик уходит не туда с `changed:true` (тихий неверный успех, verify не ловит). SPA-ре-рендер между `inspect` и `act` инвалидирует путь → `not_found` → повторный `browser_inspect` (+1 раунд, +3-6K некешируемых токенов). Это **главный токен-пожиратель**.

**1.2. Verify-налог на каждый клик.** `browser.ts:282` ставит `observed` только при `playing/currentTime/(navigated && !uncertain)`. Обычный клик, реально изменивший DOM (`changed:true` из `robustClickMain:763`), долг НЕ снимает — хотя CLAUDE.md (Волна2 2.1) это заявляет. Код и док разошлись: «нажми кнопку» = act-раунд + отдельный verify-раунд ВСЕГДА.

**1.3. Состояние тумблеров невидимо.** Вывод `inspectPageInPage:322-331` останавливается на `disabled`. Нет `checked/aria-checked/aria-selected/aria-pressed/aria-expanded/value`, нет метки `[ПУСТО]` (которая уже есть на десктоп-UIA пути сайдкара). Вопрос «тёмная тема включена?» → вынужденный `screen_capture` (~2K токенов).

**1.4. Нет примитива «вся веб-задача за раунд».** У нативного GUI есть `input_batch` → `skill.execute` (N шагов = 1 раунд). У браузера аналога НЕТ, а `browser.*` намеренно вне `BRIDGE_ALLOWED_KINDS` (jarvis SDK). Логин-форма (email+пароль+сабмит) = 3-4 LLM-раунда по одному tool-вызову, с растущим inspect-хвостом в префиксе.

**1.5. Яндекс-хардкод — три класса, каждый по своей причине:**
- `robustClickMain:590-597` и дубль `pageActInPage:1137-1141`: `/yandex/i && /(волна|вайб|vibe)/ → location.href='music.yandex.ru'`. **Это НЕ проблема поиска элемента** (у «Моей волны» есть aria-label, inspect её находит) — клик по пункту меню НЕ роутит SPA (комментарий `:1135`). Знание тут — **НАВИГАЦИЯ**, а не адресация.
- `sigOf:685` / `:1123` `[class*='Vibe']/[class*='VibePage']`: сигнатура diff под классы Яндекса → на чужом сайте падает на `body` (шумный) → ложные `changed`.
- `mediaControlMain:816-819` исключение `[class*='Wheel']` + `PLAY_LBL/PAUSE_LBL:1003-1004`: дизамбигуация глобального плеера от плиток колеса (у которых ТОТ ЖЕ aria «Воспроизведение», `:804`) через site-специфичные классы и замкнутый RU/EN словарь. Плеер с иконкой без подписи / на другом языке не распознаётся.

Итог: «на Я.Музыке заебись» = хардкод под один хост; «на других говно» = generic-путь адресуется хрупким текстом/селектором, качество снимка не конвертируется в надёжное действие.

---

## 2. Целевой механизм (одна связная идея)

**Модель адресует элемент по непрозрачному ref (`e7:12`), который она ТОЛЬКО ЧТО видела в снимке — не по CSS-пути.** Реальный `Element` лежит в `Map<ref,Element>` на `globalThis.__jarvisRefs` **в ISOLATED-world**, который on-demand-`executeScript` уже создаёт на каждый inspect/act. Этот world **живёт весь lifetime документа и разделяется между вызовами `executeScript` и между LLM-раундами** (в отличие от MAIN-world страницы), а на навигации умирает вместе с документом → ref честно протухает сам собой. Это load-bearing факт: он даёт весь ref-реестр с **нулевым новым footprint** — без `registerContentScripts`, без always-on `<all_urls>`-инъекции, без новых permissions (`manifest.json` уже несёт `scripting` + `<all_urls>`), и **без pre-existing-tab gap** (любая вкладка осматривается по требованию).

Три уровня, ложащиеся на существующий путь `расширение → handlers/browser.ts → HERMES`:

1. **ВИДЕТЬ:** `browser_inspect` → снимок `{ref, role, accessibleName, state}` + поколение `gen`. Селектор УХОДИТ из дефолтного пейлоада (ref его заменяет; остаётся opt-in fallback-полем). Состояние (`checked/selected/expanded/pressed/value/[ПУСТО]`) и ground-truth медиа — теперь ПОЛЯ снимка, а не click-эвристика.

2. **БИТЬ по идентичности:** `browser_act{ref}` / `browser_batch{steps:[{ref,intent,params}]}`. Резолвер берёт узел из `Map` по идентичности, сверяет `gen` + `el.isConnected`. Узел на месте → действие каскадом (React-onClick → Enter → pointer, как сегодня). Протух → честный `ref_stale` → принуждение к свежему `browser_inspect`, НИКОГДА слепой клик.

3. **СЖАТЬ раунды:** `browser_batch` гонит ≤12 шагов против ОДНОГО снимка за один tool-вызов (веб-аналог `input_batch`), stop-on-first-error, честное «выполнено k из n». Стабильный ref — ровно то, что делает батчинг БЕЗОПАСНЫМ (каждый шаг адресует идентичность, mid-batch ре-рендер ловится per-step `isConnected`).

Доменное знание (Яндекс) переезжает из КОДА в **per-host рецепт-данные** `learned__site-recipe__<host>`, рекуллимые по ТОЧНОМУ hostname (мимо шумного e5-small).

---

## 3. Компоненты (реальные пути этого репо)

| Файл | new/changed | Роль |
|---|---|---|
| `apps/extension/background.js` | changed | **Ядро.** Реестр `globalThis.__jarvisRefs = {gen, map}` в ISOLATED-world. `inspectPageInPage` → минтит `ref`+`accessibleName`+`state`, кладёт `Element` в map, чистит старый gen. `tabAct`/новый `tabBatch` принимают `{ref,gen}`; `resolveRef` по идентичности; для React-клика — **just-in-time nonce-стамп ОДНОГО узла** (мост в MAIN). **УДАЛИТЬ**: `:590-597`, `:1137-1141` (yandex→location.href), `[class*='Vibe']` в sigOf `:685`/`:1124`, `[class*='Wheel']` `:816-819`; **демоутить** `PLAY_LBL/PAUSE_LBL` `:1003-1004` в fallback. sigOf → контейнер целевого узла. Fix мёртвого `break` `:272` + расширить data-* allowlist. |
| `apps/extension/modules/ax.js` | **new** | Self-contained (CSP-safe): `accessibleName` (прагматичный subset accname-1.2: `aria-labelledby→aria-label→label[for]→text→placeholder/title`) + вычисление роли + видимость/hit-test + state-ридер. Импортируется inspect/act/probe (убирает копипасту). `build.mjs` уже бандлит `./modules/*` в `dist/background.js` — новый файл подхватится импортом. |
| `apps/extension/manifest.json` | **unchanged** | Permissions уже достаточны (`scripting`+`<all_urls>`). Осознанно: НИ `registerContentScripts`, НИ `content_scripts` — реестр в on-demand isolated-world. |
| `apps/client/scripts/build.mjs` | unchanged | Расширение уже бандлится одним entry (`:71`). Нового entry не нужно. |
| `apps/server/src/gateway/extension-bridge.ts` | changed | `tabBatch(url,tabId,steps,timeoutMs)` → `request({type:'tab.batch'},~60_000)`; `tabInspect`/`tabAct` несут `ref`/`gen`. |
| `apps/server/src/brain/tools/handlers/browser.ts` | changed | `browserInspect` → `{ref,gen,state}`; `browserAct` принимает `ref`; **новый `browserBatch`**; **переработка `observed`** (`:282`) с ранжированием по достоверности; `ref_stale` → честный err по образцу `frame_gone` (`:374`); **recall рецепта по hostname** → инжект untrusted-хинтом; фикс CDP-read без `untrusted()` (`:199`). |
| `apps/server/src/brain/tools/dispatch.ts` | changed | `case "browser_batch"`; классификация. |
| `packages/tools/src/index.ts` | changed | `browser_inspect` output = `{ref,role,name,state}`; `browser_act` += `params.ref`; **новый `browser_batch`** (ГОРЯЧИЙ); переписать описания «адресуй по ref из последнего снимка». |
| `apps/server/src/brain/agent/error-voice.ts` | changed | `browser_batch` → `BLIND_MUTATE_TOOLS` (`:131`) + `mutate` (как `input_batch`); `browser_inspect` остаётся VERIFY. |
| `apps/server/src/memory/site-recipes.ts` | **new** | Per-host стор рецептов, ключ = ТОЧНЫЙ hostname (map-lookup, мимо e5). `recall(host)`/`upsert(host,tuples)`; verify-сигнал на кортеж; `fail_count`-демоция (реюз `SKILL_FAIL_SUPPRESS`). Персист как HERMES. |
| `apps/server/src/seed/shared-skills.ts` | changed | `learned__generic-site-actions` (`:114`) → ref/batch-цикл. `yandex-music-control`/`site-player-control` → **рецепт-ДАННЫЕ** (`music.yandex.ru`: intent→locator+verify+navFallback) — бывший хардкод как ПЕРВАЯ запись. |
| `apps/server/src/brain/agent/index.ts` | changed | Терминал браузерной задачи (рядом с `recordOutcome`): на ВЕРИФИЦИРОВАННОМ успехе → `siteRecipes.upsert(host, tuples)` (Фаза 4). |
| `apps/server/src/brain/persona/persona.md` | changed | Бамп version; лестница наблюдения + «адресуй по ref, батчь механические шаги, независимые чтения — вместе». |
| `apps/client/main/actuators/jarvis-browser-page.ts` | changed (Фаза 5, опц.) | Зеркалить ref-цикл в невидимом CDP-браузере (обобщить `__tg`). |

---

## 4. Модель действий

### 4.1. Реестр по идентичности (несущий выбор реализации)

`inspectPageInPage` (ISOLATED): обходит DOM + открытые shadow-root + фреймы (как сейчас `collectDeep`), фильтрует видимый интерактив (`getClientRects`+computed style + `elementFromPoint` hit-test для top-most). Каждому узлу — `ref = "e"+gen+":"+n` (frame-scoped: `f2e5:12`). Реальный `Element` → `globalThis.__jarvisRefs.map.set(ref, el)`; `gen` монотонно растёт, **старый gen-map чистится явно** (strong-ref держит detached-узлы только до следующего inspect/навигации — течь ограничена десятками интерактивных узлов). Модель получает:

```
- textbox "Логин" [f0e7:3] [ПУСТО]
- textbox "Пароль" [f0e7:4] [password]
- button "Войти" [f0e7:9] [disabled=false]
- checkbox "Запомнить" [f0e7:11] [checked=false]
```

Никаких CSS-путей в дефолтном пейлоаде. Всё обёрнуто в `<untrusted_content>` (role/name/value — page-controlled, M11).

### 4.2. Действие: `browser_act{ref}` и решение MAIN/ISOLATED

Резолвер (ISOLATED `executeScript`): `gen` совпал? → `map.get(ref)` есть и `el.isConnected`? Нет → `ref_stale` (форс re-inspect). Да → actionability-гейт (visible/stable/enabled/hit-test).

**Границу MAIN/ISOLATED — главную слабость RefGrid — снимаем так:** `__reactProps$` виден ТОЛЬКО в MAIN; но native-click, pointer-цепочка, чтение `aria-*`, `el.checked/.value`, `media.paused` — всё читаемо/исполнимо в ISOLATED. Поэтому:
- `type/seek/scroll/select/setValue`, чтение state — **ISOLATED, 1 инъекция** (реестр там же).
- `click` (нужен React-first ладдер против Swiper-гейта) — **ISOLATED резолвит ref по идентичности и стампит `data-jarvis-act=<nonce>` на ЕДИНСТВЕННЫЙ целевой узел** → MAIN `executeScript` находит `[data-jarvis-act="<nonce>"]` (проверка: ровно 1 матч, иначе abort — анти-hijack), гонит `robustClickMain` (react→enter→pointer, как `:700-745`), снимает `data-jarvis-act`. 2 инъекции — это **миллисекунды wall-clock, не токены/раунды**, и это сохраняет react-first обход Swiper. Стамп — на ОДНОМ узле, эфемерный, uniqueness-checked.

`selector`/`text` остаются FALLBACK (гибрид browser-use) — когда свежего снимка нет. Регрессий нет.

### 4.3. `browser_batch` — сжатие раундов

```
browser_batch{steps:[
  {ref:"f0e7:3", intent:"type", params:{text:"user@x.com"}},
  {ref:"f0e7:4", intent:"type", params:{text:"···"}},
  {ref:"f0e7:9", intent:"click", commit:true}
]}
```

SW-функция `tabBatch` (БЕЗ LLM в цикле): валидирует ВСЕ ref против текущего gen ДО исполнения (молчаливый no-op не маскируется успехом — как `inputBatch`), гонит шаги последовательно, стоп на первой ошибке, возвращает `{results:[{ref,ok,observed,...}], stoppedAt, k, n}`. Реестр в isolated-world персистит между шаговыми `executeScript`. Многополевая форма = **1 LLM-раунд**. Граница честности: шаги адресуют ТОЛЬКО ref из текущего снимка; progressive-disclosure (клик→дропдаун→новый пункт) — это 2 батча/раунда (новые узлы не были в снимке), но это честно и всё равно кратно дешевле. `commit:true` (Enter, который постит) → verify-долг НЕ снимается наблюдением (см. §7).

### 4.4. Семантические интенты (лёгкий слой, не растущий словарь)

`play/pause/next/search/submit` резолвятся по `role + accessibleName` + generic мультиязычный хинт-набор (RU/EN старт, расширяем), НО первичная дизамбигуация — **ref-идентичность** (модель видела и выбрала) + **state ground-truth** (media.paused флипнулся = сработала ПРАВИЛЬНАЯ кнопка). Отличие от дизайна #3, где INTENT_TABLE — растущий вручную лексикон: у нас таблица — тонкий fallback, надёжность несут ref+state, а не словарь синонимов.

### 4.5. Визуальный fallback (canvas/WebGL/MSE) — осознанный предел

DOM-пусто → `browser_act` честно `not_found` → **существующий** canvas escape-hatch (`markBrowserActMiss` → `screen_capture` + `input_click`, `browser.ts:39-52`). SoM (пронумерованный оверлей) — **опциональная Фаза 6+**, и НЕ через `captureVisibleTab` (view-steal активной вкладки + DPI-проблемы), а поверх уже имеющегося `screen_capture`. Ref-путь НЕ притворяется, что видит пиксели.

---

## 5. Как убивается Яндекс-хардкод

| Хардкод | Чем заменяется |
|---|---|
| `location.href='music.yandex.ru'` (`:590-597`,`:1137-1141`) | **Generic recovery по ДАННЫМ рецепта.** Рецепт несёт поле `navFallback`. Движок: после клика, если `location.href` НЕ изменился И контейнер-сигнатура НЕ изменилась И рецепт задал `navFallback` → навигируем. Это кодирует «клик не роутит SPA» как generic-правило «clicked but URL+sig unchanged → go to recorded URL», работающее на любом таком SPA. `music.yandex.ru` — первая seed-запись, а не `/yandex/`. |
| `[class*='Vibe']` в sigOf (`:685`,`:1124`) | Сигнатура diff = innerText **ближайшего стабильного контейнера целевого узла** (вверх от target до элемента с id/`role=main`/landmark), а не yandex-класс. `changed` становится generic и достоверным по привязке к действию (но остаётся WEAK для снятия долга — §7). |
| `[class*='Wheel']` исключение (`:816-819`) | Дизамбигуация глобального плеера от плиток колеса — через **ref-идентичность** (модель выбрала транспортную кнопку из снимка) + **media ground-truth** (клик по плитке НЕ флипнет `media.paused` → `observed` не ставится → честный «не сработало» + re-inspect, НЕ ложный успех). `.swiper-slide-duplicate` — библиотечно-generic (клоны Swiper), остаётся как общий фильтр карусели. |
| `PLAY_LBL/PAUSE_LBL` (`:1003-1004`) | Демоутятся в тонкий generic-хинт. State плеера — по `media.paused`/`mediaSession` (уже generic, `:820`). Поиск кнопки — `role=button` + accessibleName; для известного хоста — locator из рецепта. |

Любой новый сайт получает ту же машинерию (ref-реестр + batch + accessibleName + рецепт) **без единой строки site-specific кода**.

---

## 6. Токен-экономика и сокращение раундов (оценки)

**Снимок (доминирующая статья).** Сегодня: элемент `{idx,tag,role,text≤80,aria≤80,selector 30-120,disabled,href}` ≈ 60-90 ток (RU); cap=80 → **3-6K**. Новый: `{ref ~3 ток, role, name≤60, state}` ≈ 25-40 ток; cap=80 → **~1.5-2.5K**. **~2× сжатие**. State-поля добавляют семантику, которая сейчас требует отдельного `screen_capture` (~1.5-2K) на вопрос «тумблер вкл?» — эта поездка исчезает.

**Verify-раунд.** Fused-observe расширяется на native-control/навигацию/value-readback (§7) → отдельный verify-раунд снимается там, где исход достоверен. Стек уже мерил fused-observe в −35-50% раундов; расширение переносит это на обычные клики с достоверным target-state.

**browser_batch — главный рычаг.** Логин-форма: сегодня `open→inspect→type→type→click→verify` ≈ 5-6 раундов → `open→inspect→batch` ≈ **3 раунда**. Многоэкранная форма → единицы.

**Ref-идентичность убирает re-inspect на промахах.** Класс «стейл/неоднозначный селектор → not_found → re-inspect(+3-6K)→re-act» исчезает.

**Суммарно на «сделай X на незнакомом сайте»:** одиночное действие ~4 раунда → ~2-3; многошаговая форма ~6-10 → ~3. Плюс ~2× по токенам снимка и снятие квадратичного накопления inspect-дампов в префиксе.

---

## 7. Сохранение законов честности

**Клик ≠ результат / ранжированный fused-observe.** `browser.ts:282` переписывается с ранжированием сигналов ПО ДОСТОВЕРНОСТИ, привязанных к ЦЕЛЕВОМУ узлу:
- **STRONG (снимают verify-долг):** `media.paused`/`currentTime` (нативно); достоверная навигация (`location.href`-дельта, НЕ `uncertain`); нативный readback целевого узла — `el.value` после type, `el.checked`/`el.selected` после toggle.
- **WEAK (НЕ снимают, только докладываются):** `changed:true` (контейнер-diff), `aria-*`-флип (page-authored, спуфимо), **появление нового узла** (модалка/дропдаун). Это прямое закрытие ловушки «new node appeared → false готово».

Так «нажми кнопку → навигация/тумблер/ввод» снимает долг в том же раунде, а «клик открыл меню» — нет. Строже сегодняшнего кода на weak-сигналах, щедрее на достоверных.

**Autoplay.** `mediaControlMain` по-прежнему возвращает `autoplayBlocked` честно (`:869`); `media.paused` не флипнулся → `observed` не ставится → «нужен живой клик», не ложное «играет».

**Untrusted.** Снимок (role/name/value = page-controlled), mini-snap, `navigated`/`frameUrl` — в `<untrusted_content>` с санитизацией `[<>]` (как `browserAct:269`). Фиксится и забытый CDP-read без обёртки (`browser.ts:199`).

**Verify-долг / blindMutatePending.** `browser_act` остаётся `BLIND_MUTATE`; `browser_batch` добавляется в `BLIND_MUTATE_TOOLS` — observed снимает долг только по STRONG-сигналу. `ref_stale` = честный err, НЕ слепой повтор. `commit:true`-шаг (Enter, который постит в залогиненной сессии) → долг НЕ снимается наблюдением поля, требуется сверка ИСХОДА — выравнивание с `composedPending`.

**Аренда ввода.** `browser.act` уже в `INPUT_BEARING_KINDS` (`input-kinds.ts:31`). `browser_batch` берёт ту же аренду ОДИН раз на N шагов.

**Безопасность моста.** `browser.*` остаётся ВНЕ `BRIDGE_ALLOWED_KINDS` — веб-движок server-driven через `ExtensionBridge`, не через code_run-мост. Инкрементальной привилегии НЕТ: batch делает ровно то же механическое, что `browser_act` сегодня. SSRF-гард (`browserUrlBlocked`), приватные фреймы (`isPrivateHost`), реестр в ISOLATED (страница не читает `__jarvisRefs`) — целы.

**Гейт авто-реплея.** `replay-gate.ts` не затрагивается: рецепты — recall-ХИНТ (данные в tool_result), исполняемый моделью через `browser_batch` с per-step сверкой, а НЕ слепой server-driven реплей. Реплей рецепта само-заземляется (re-inspect → role+name→ref) и обязан пройти сохранённый verify-сигнал.

---

## 8. Поэтапный rollout (каждая фаза ценна и тестируема живьём)

**Фаза 0 — дешёвые независимые фиксы (без реестра, без риска).** (а) `browser.ts:282`: снимать долг на STRONG target-state (media/nav/native-readback), оставить weak не-снимающими — закрывает задокументированный разрыв Волны2 2.1. (б) Обогатить `inspectPageInPage` output: `checked/aria-checked/aria-selected/aria-pressed/aria-expanded/value` + `[ПУСТО]` для пустых полей + `accessibleName` — аддитивно, селектор сохранить. (в) Фикс мёртвого `break` `selFor:272` + расширить data-* allowlist (`data-cy/data-automation-id/data-e2e`). **Живой смоук:** тумблер-вопрос без `screen_capture`; клик-навигация без лишнего verify-раунда.

**Фаза 1 — ref-реестр (гибрид, за флагом `JARVIS_BROWSER_REF`, деф off).** `globalThis.__jarvisRefs` в ISOLATED; inspect минтит ref+gen; `browser_act{ref}` ПАРАЛЛЕЛЬНО selector-fallback; `ref_stale` → честный err; nonce-мост для React-клика. **Живой смоук в реальном Chrome:** клик в списке одинаковых карточек, поле в shadow-DOM, элемент в iframe, ре-рендер SPA. Регресс-гейт на Я.Музыке ДО удаления хардкодов.

**Фаза 2 — `browser_batch` (за `JARVIS_BROWSER_BATCH`).** Схема (ГОРЯЧАЯ) + `tabBatch` + `browserBatch` + классификация `BLIND_MUTATE`. Валидация ref до исполнения, stop-on-first-error, `commit`-гейт. **Смоук:** логин-форма за 1 раунд; сверка, что `commit` держит verify-долг.

**Фаза 3 — убрать selector из дефолта + переработать fused-observe на ref-mini-snap.** Селектор → opt-in fallback-поле. mini-snap возвращает STRONG/WEAK target-state.

**Фаза 4 — УБИТЬ Яндекс-хардкод + per-host рецепты.** `site-recipes.ts`, recall по hostname (мимо e5), инжект хинтом; seed `music.yandex.ru` рецептом-данными (с `navFallback`); УДАЛИТЬ `:590-597`/`:1137-1141`/`[class*='Vibe']`/`[class*='Wheel']`, демоутить `PLAY_LBL`; sigOf → контейнер целевого узла; авто-запись выигравших кортежей на верифицированном успехе. Переписать `learned__generic-site-actions` в ref/batch-цикл. **АДВЕРСАРИАЛЬНОЕ multi-agent ревью до нуля находок** (закон владельца): play/pause/Моя волна/встряхнуть работают на Я.Музыке через generic ref+recipe И на втором незнакомом плеере; autoplay-гейт, untrusted, `changed:false`≠успех, `ref_stale`≠слепой хит — целы.

**Фаза 5 (опц.) — конвергенция суррогатов.** Зеркалить ref-цикл в невидимом CDP-браузере (`jarvis-browser-page.ts`, обобщить `__tg`).

**Фаза 6 (опц.) — SoM для canvas** поверх `screen_capture` (не `captureVisibleTab`), если DOM-less-класс станет частым.

---

## 9. Риски и открытые вопросы

- **MAIN/ISOLATED для React-клика.** 2 инъекции на click (ISOLATED-стамп → MAIN-act). Wall-clock ~ms, но лишний page-side проход на React-heavy сайтах. Митигация: `type/seek/scroll` — чисто ISOLATED; nonce uniqueness-checked. Проверять на React+Swiper вживую.
- **strong-ref Map держит detached-узлы** до следующего inspect/навигации. Ограничено десятками узлов; явная чистка старого gen. WeakMap непригоден: нужен `isConnected`-обход.
- **accessibleName — прагматичный subset**, не полный accname-1.2. Не критично: ref всё равно бьёт по идентичности; имя — для выбора моделью.
- **`navFallback` recovery — эвристика.** «URL+sig не изменились после клика → навигируй» может ложно сработать на клике, меняющем только вне-контейнерный UI. Митигация: только когда рецепт явно задал `navFallback`; контейнер-sig привязан к целевому узлу.
- **Frame-scoped ref vs единый tab-level gen:** каждый фрейм-world держит свой `gen`; сервер хранит per-frame gen в `browserTarget`. Sandbox-фреймы (`no allow-scripts`) → нет реестра → честный fallback на top.
- **Progressive-disclosure формы** (клик→дропдаун→пункт) — не 1 батч, а 2. Честная граница.
- **Cross-origin iframe и canvas/MSE** — по-прежнему предел (SOP, нет DOM). `browser_run{script}` отвергнут: MV3 CSP блокирует eval модель-авторского JS — `browser_batch` (декларативный статичный интерпретатор) даёт то же сжатие раундов без showstopper'а.
- **Живой смоук — обязателен и только за владельцем.** Реестр в isolated-world, nonce-мост, batch, удаление Яндекс-веток проверяются ТОЛЬКО reload расширения + не-Яндекс сайт с iframe/shadow/списками. Удаление хардкодов может вскрыть регресс на Я.Музыке до готовности рецепта — потому Фаза 4 после регресс-гейта.
- **Открытый трек:** сильнее эмбеддер (e5-large/реранкер) снял бы зависимость recall от hostname-костыля для не-браузерных навыков.

---

## Ранжирование панели

1. **[6.7] RefGrid** — стабильный ref-реестр вместо CSS-селекторов *(взят за основу)*
2. [6.3] browser_som — DOM-grounded Set-of-Marks (пронумерованный оверлей) *(→ Фаза 6, опц.)*
3. [6.1] Semantic Web Actuation — intent-таблица + ref + per-host рецепты *(привиты рецепты + семантические интенты как тонкий слой)*
4. [5.4] browser_run web-SDK *(отвергнут: MV3 CSP блокирует eval; сжатие раундов даёт `browser_batch`)*
