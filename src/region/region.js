"use strict";

/**
 * Оверлей выделения области.
 *
 * Раньше рамка «схлопывалась» сразу после отпускания: полученную область нельзя
 * было поправить, приходилось выбирать заново. Теперь после рисования рамка
 * остаётся, её края тянутся по одному, а крестик на верхней линии переносит
 * рамку целиком. Подтверждение — Enter, отмена — Esc.
 */
(() => {
  const qs = new URLSearchParams(location.search);
  I18N.setLang(qs.get("lang") === "en" ? "en" : "ru");
  I18N.applyDom();
  window.regionApi.onLang((lang) => {
    I18N.setLang(lang);
    I18N.applyDom();
    renderTexts();
  });

  const sel = document.getElementById("sel");
  const size = document.getElementById("size");
  const hint = document.getElementById("hint");
  const move = document.getElementById("move");
  const actions = document.getElementById("actions");
  const backdrop = document.getElementById("backdrop");

  // Снимок экрана приходит из main: под ним экран заморожен, поэтому ничего
  // не «плывёт» и не размывается во время выделения.
  window.regionApi.onBackdrop?.((dataUrl) => {
    if (!dataUrl) return;
    backdrop.src = dataUrl;
    backdrop.hidden = false;
  });

  // Замороженный снимок кладём ровно в пиксель экрана: main передаёт размер
  // дисплея, потому что окно оверлея может быть ниже экрана на панель задач.
  // Без этого картинка сжималась по высоте, и рамка выделяла не то, что видно.
  const query = new URLSearchParams(location.search);
  // Подпись клавиши — коротко, как на клавиатуре: Ctrl, Win.
  const prettyAccel = (accel) =>
    String(accel || "").replace(/Control|CommandOrControl/g, "Ctrl").replace(/Super|Meta/g, "Win");
  // Цвета выбранной темы (rgb акцента, тёмный текст на нём, светлый вариант).
  const accent = query.get("accent");
  if (/^\d{1,3} \d{1,3} \d{1,3}$/.test(accent || "")) {
    document.documentElement.style.setProperty("--acc", accent);
    const ink = query.get("ink");
    const hi = query.get("hi");
    if (/^#[0-9a-f]{6}$/i.test(ink || "")) document.documentElement.style.setProperty("--acc-ink", ink);
    if (/^#[0-9a-f]{6}$/i.test(hi || "")) document.documentElement.style.setProperty("--acc-hi", hi);
  }
  const displayW = Number(query.get("w")) || 0;
  const displayH = Number(query.get("h")) || 0;
  if (displayW > 0 && displayH > 0) {
    backdrop.style.width = `${displayW}px`;
    backdrop.style.height = `${displayH}px`;
  }

  const MIN_SIDE = 16;
  // Намерение приходит из main: у записи и снимка разные подписи.
  const intent = query.get("intent") === "shot" ? "shot" : "video";
  // Клавиша, которой рамку можно подтвердить повторно: подписываем ею кнопку
  // и подсказку вместо жёсткого «Enter».
  const hotkey = prettyAccel(query.get("hotkey")).trim();
  const confirmKey = hotkey || "Enter";
  // Подписи считаем при каждом рендере: смена языка сразу обновляет их.
  const acceptLabel = () => I18N.t(intent === "shot" ? "Снимок" : "Записать");
  const confirmWord = () => I18N.t(intent === "shot" ? "снимок" : "записать");
  const hintIdleHtml = () => I18N.t("Тяните рамку мышью · {0} — отмена", "<b>Esc</b>");
  // Главное, чего не хватало: явно сказать, что рамку надо подтвердить.
  const hintAdjustHtml = () =>
    I18N.t("Тяните края, ✛ переносит · <kbd>{0}</kbd> — {1}", confirmKey, confirmWord()) +
    `<br><span class="hint-sub">` +
    I18N.t("или кнопка «{0}» внизу", acceptLabel()) +
    (intent === "video"
      ? I18N.t(" · Esc — отмена")
      : I18N.t(" · <kbd>Ctrl</kbd>+<kbd>C</kbd> — в буфер · Esc — отмена")) +
    `</span>` +
    // Подсказка на случай «куда пропало моё окно»: при включённой защите
    // приложение не попадает ни в подложку, ни в запись.
    (query.get("selfHidden") === "1"
      ? `<br><span class="hint-sub">` +
        I18N.t("окно Screen Revesane не попадёт в кадр — включите «Своё окно: в кадре» на главной") +
        `</span>`
      : "");

  // Формат записи выбирается прямо в оверлее: только для видео. Снимку он
  // не нужен, а копирование в буфер для видео вредно — Ctrl+C закрывал оверлей
  // и клал картинку в буфер вместо запуска записи.
  const FORMATS = [
    ["auto", "как у Chromium"],
    ["mp4", "MP4"],
    ["mov", "MOV"],
    ["mkv", "MKV"],
    ["wmv", "WMV"],
    ["webm", "WebM"],
    ["gif", "GIF"],
    ["f4v", "F4V"],
    ["ts", "MPEG-TS"],
  ];
  const formatWrap = document.getElementById("fmt-wrap");
  const formatSelect = document.getElementById("format");
  const copyButton = document.getElementById("copy");
  // Переводится только подпись «auto»; имена контейнеров остаются как есть.
  const formatText = (value, label) => (value === "auto" ? I18N.t(label) : label);
  if (intent === "video") {
    for (const [value, label] of FORMATS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = formatText(value, label);
      formatSelect.appendChild(option);
    }
    formatSelect.value = query.get("container") || "auto";
    formatWrap.hidden = false;
    copyButton.hidden = true;
  } else {
    formatWrap.hidden = true;
  }

  let rect = null;
  let mode = "idle"; // idle | draw | resize | move
  let anchor = null;
  let startRect = null;
  let startPoint = null;
  let resizeDir = null;
  let moveOffset = null;
  let finished = false;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  /** Держим рамку внутри экрана, не ломая её размер без нужды. */
  function fitView(target) {
    const maxW = window.innerWidth;
    const maxH = window.innerHeight;
    const width = clamp(target.width, MIN_SIDE, maxW);
    const height = clamp(target.height, MIN_SIDE, maxH);
    return {
      x: clamp(target.x, 0, maxW - width),
      y: clamp(target.y, 0, maxH - height),
      width,
      height,
    };
  }

  function rectFrom(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }

  function paint() {
    if (!rect) return;
    sel.classList.add("on");
    sel.style.left = `${rect.x}px`;
    sel.style.top = `${rect.y}px`;
    sel.style.width = `${rect.width}px`;
    sel.style.height = `${rect.height}px`;
    size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    // У верхнего края крестик ушёл бы за экран — переносим его внутрь рамки.
    sel.classList.toggle("grip-inside", rect.y < 40);
    sel.classList.toggle("narrow", rect.width < 150);
    dock();
  }

  /**
   * Кнопки — сразу под рамкой, подсказка — над ней (над крестиком переноса).
   * Не хватает места снаружи — переезжают внутрь рамки к её краю; по
   * горизонтали держатся по центру рамки, но не уходят за экран.
   */
  function dock() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const centerX = (w) => clamp(rect.x + rect.width / 2 - w / 2, 8, Math.max(8, vw - w - 8));
    if (!actions.hidden) {
      const aw = actions.offsetWidth;
      const ah = actions.offsetHeight;
      const bottom = rect.y + rect.height;
      // 34 px — место под бейджем размера рамки.
      let top = bottom + 34;
      if (top + ah > vh - 8) top = rect.y - ah - 48 >= 8 ? rect.y - ah - 48 : bottom - ah - 14;
      actions.classList.add("docked");
      actions.style.left = `${Math.round(centerX(aw))}px`;
      actions.style.top = `${Math.round(Math.max(8, top))}px`;
    }
    const hw = hint.offsetWidth;
    const hh = hint.offsetHeight;
    const actionsTop = actions.hidden ? null : parseFloat(actions.style.top);
    // Кнопкам не хватило места снизу и они встали над рамкой — подсказка над ними.
    const actionsAbove = actionsTop !== null && actionsTop < rect.y;
    // 44 px — над крестиком переноса, который торчит над рамкой.
    let top = actionsAbove ? actionsTop - hh - 10 : rect.y - hh - 44;
    if (top < 8) {
      // Сверху места нет: внутрь рамки у верхнего края, если она достаточно
      // высокая, иначе под кнопки.
      if (rect.height > hh + 60) top = rect.y + 44;
      else if (!actions.hidden) top = (parseFloat(actions.style.top) || 0) + actions.offsetHeight + 10;
      else top = rect.y + rect.height + 34;
    }
    hint.classList.add("docked");
    hint.style.left = `${Math.round(centerX(hw))}px`;
    hint.style.top = `${Math.round(clamp(top, 8, vh - hh - 8))}px`;
  }

  // Какую подсказку показываем: храним вид, а не готовый HTML, чтобы при
  // смене языка пересобрать её через I18N.t.
  let hintKind = "idle"; // idle | adjust | need-draw | snap
  // Режим снимка внутри выделения видео и рамка видео, к которой вернёмся.
  let snapMode = false;
  let videoRect = null;
  const shotKey = prettyAccel(query.get("shotKey"));
  let hintDim = false;

  function renderHint() {
    const html =
      hintKind === "snap"
        ? I18N.t("Снимок экрана вместе с рамкой: выделите область · {0} — сохранить · {1} — копировать · {2} — назад к видео", `<b>Enter${shotKey ? ` / ${shotKey}` : ""}</b>`, "<b>Ctrl+C</b>", "<b>Esc</b>")
        : hintKind === "adjust"
        ? hintAdjustHtml()
        : hintKind === "need-draw"
          ? I18N.t("Сначала выделите рамку мышью, потом нажмите клавишу ещё раз")
          : hintIdleHtml();
    hint.innerHTML = html;
    hint.style.opacity = hintDim ? "0.35" : "1";
  }

  function setHint(kind, dim) {
    hintKind = kind;
    hintDim = dim;
    renderHint();
  }

  function inside(point) {
    return (
      rect &&
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    );
  }

  function done(result) {
    if (finished) return;
    finished = true;
    // copy обязан доехать до main: по нему решается, открывать редактор
    // или молча положить снимок в буфер.
    window.regionApi.done(
      result
        ? {
            x: Math.round(result.x),
            y: Math.round(result.y),
            width: Math.round(result.width),
            height: Math.round(result.height),
            copy: Boolean(result.copy),
            // Формат, выбранный в оверлее: для видео он уезжает в настройки,
            // чтобы запись шла в выбранном контейнере.
            container: intent === "video" ? formatSelect.value : null,
          }
        : null,
    );
  }

  /** Тянем одну из сторон; противоположная остаётся на месте. */
  function resizeBy(dir, dx, dy) {
    const edges = {
      left: startRect.x,
      top: startRect.y,
      right: startRect.x + startRect.width,
      bottom: startRect.y + startRect.height,
    };
    if (dir.includes("w")) edges.left = clamp(edges.left + dx, 0, edges.right - MIN_SIDE);
    if (dir.includes("e")) edges.right = clamp(edges.right + dx, edges.left + MIN_SIDE, window.innerWidth);
    if (dir.includes("n")) edges.top = clamp(edges.top + dy, 0, edges.bottom - MIN_SIDE);
    if (dir.includes("s")) edges.bottom = clamp(edges.bottom + dy, edges.top + MIN_SIDE, window.innerHeight);
    rect = fitView({
      x: edges.left,
      y: edges.top,
      width: edges.right - edges.left,
      height: edges.bottom - edges.top,
    });
    paint();
  }

  function startAdjust() {
    mode = "adjust";
    sel.classList.add("adjust");
    actions.hidden = false;
    setHint(snapMode ? "snap" : "adjust", false);
    paint();
    // Подсказка поменяла текст и размер — пересчитать место.
    requestAnimationFrame(() => rect && dock());
  }

  window.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    // Кнопки и список форматов под рамкой — не начало новой рамки: раньше
    // клик по «Формат» сбрасывал выделение до 16×16.
    if (event.target.closest?.("#actions, #hint")) return;
    const grip = event.target.closest?.(".grip");
    if (mode === "adjust" && grip) {
      resizeDir = grip.dataset.dir;
      startRect = { ...rect };
      startPoint = { x: event.clientX, y: event.clientY };
      mode = "resize";
      sel.classList.add("busy");
      return;
    }
    // Нажатие внутри рамки (в том числе по крестику) переносит её целиком.
    // В режиме снимка нажатие внутри рамки рисует новую (снять часть области
    // видео), а переносит рамку только крестик.
    const grabInside = !snapMode && inside({ x: event.clientX, y: event.clientY });
    if (mode === "adjust" && (event.target.closest?.("#move") || grabInside)) {
      moveOffset = { x: event.clientX - rect.x, y: event.clientY - rect.y };
      mode = "move";
      sel.classList.add("busy");
      return;
    }
    // Иначе начинаем новую рамку.
    mode = "draw";
    anchor = { x: event.clientX, y: event.clientY };
    sel.classList.remove("adjust", "busy");
    setHint(snapMode ? "snap" : "idle", true);
    rect = { x: anchor.x, y: anchor.y, width: 0, height: 0 };
    paint();
  });

  window.addEventListener("mousemove", (event) => {
    if (mode === "draw" && anchor) {
      rect = fitView(rectFrom(anchor, { x: event.clientX, y: event.clientY }));
      paint();
      return;
    }
    if (mode === "resize" && startRect) {
      resizeBy(resizeDir, event.clientX - startPoint.x, event.clientY - startPoint.y);
      return;
    }
    if (mode === "move" && moveOffset) {
      rect = fitView({
        x: event.clientX - moveOffset.x,
        y: event.clientY - moveOffset.y,
        width: rect.width,
        height: rect.height,
      });
      paint();
    }
  });

  window.addEventListener("mouseup", (event) => {
    if (event.button !== 0) return;
    if (mode === "adjust" && event.target.closest?.("#actions, #hint")) return;
    if (mode === "draw") {
      if (!rect || rect.width < MIN_SIDE || rect.height < MIN_SIDE) {
        rect = null;
        sel.classList.remove("on", "adjust");
        hint.classList.remove("docked");
        hint.style.left = "";
        hint.style.top = "";
        setHint(snapMode ? "snap" : "idle", false);
        mode = "idle";
        return;
      }
      startAdjust();
      return;
    }
    if (mode === "resize" || mode === "move") {
      sel.classList.remove("busy");
      mode = "adjust";
      setHint(snapMode ? "snap" : "adjust", false);
    }
  });

  window.addEventListener("keydown", (event) => {
    // Enter в открытом списке форматов выбирает пункт, а не запускает запись.
    if (event.key === "Enter" && event.target === formatSelect) return;
    if (event.key === "Escape") {
      if (snapMode) exitSnapMode();
      else done(null);
      return;
    }
    if (snapMode) {
      if (event.key === "Enter" && mode === "adjust" && rect) void takeSnap(false);
      if ((event.ctrlKey || event.metaKey) && (event.code === "KeyC" || event.key.toLowerCase() === "c") && mode === "adjust" && rect) {
        event.preventDefault();
        void takeSnap(true);
      }
      return;
    }
    // Ctrl+C — снять область и положить в буфер, как в «Ножницах».
    // Проверяем физическую клавишу (event.code): в русской раскладке event.key
    // приходит как «с», и Ctrl+C молча не срабатывал. Для видео копирование
    // выключено: там та же комбинация мешала запуску записи.
    if (
      intent === "shot" &&
      mode === "adjust" &&
      rect &&
      (event.ctrlKey || event.metaKey) &&
      (event.code === "KeyC" || event.key.toLowerCase() === "c")
    ) {
      event.preventDefault();
      done({ ...rect, copy: true });
      return;
    }
    if (event.key === "Enter" && mode === "adjust" && rect) {
      done(rect);
    }
  });

  document.getElementById("accept").addEventListener("click", () => {
    if (!snapMode && mode === "adjust" && rect) done(rect);
  });
  // Горячая клавиша «выделить и записать видео», нажатая второй раз, подтверждает
  // рамку: не нужно тянуться к Enter или кнопке. Если рамки ещё нет — говорим,
  // что делать, вместо молчаливого игнорирования.
  window.regionApi.onConfirm?.(() => {
    // Клавиша записи в режиме снимка — вернуться к рамке видео.
    if (snapMode) {
      exitSnapMode();
      return;
    }
    if (mode === "adjust" && rect) {
      done(rect);
      return;
    }
    setHint("need-draw", false);
  });
  document.getElementById("copy").addEventListener("click", () => {
    if (mode === "adjust" && rect) done({ ...rect, copy: true });
  });
  document.getElementById("cancel").addEventListener("click", () => done(null));

  // Подпись меняем только у надписи: бейдж <kbd>Enter</kbd> внутри кнопки
  // должен остаться на месте.
  document.getElementById("accept-label").textContent = acceptLabel();
  // Для видео на кнопке — красная точка REC: сразу видно, что начнётся запись.
  if (intent === "video") {
    document.getElementById("rec-dot").hidden = false;
    document.getElementById("accept").classList.add("has-rec");
  }
  window.addEventListener("resize", () => rect && dock());

  // Снимок рамки из окна выделения видео: кнопка «Снимок» и клавиша снимка
  // области. Окно не закрывается — следом можно записать эту же область.
  const snapButton = document.getElementById("snap");
  const snapNote = document.getElementById("snap-note");
  let noteTimer = 0;
  function showNote(text, error) {
    snapNote.textContent = text;
    snapNote.classList.toggle("is-error", Boolean(error));
    snapNote.hidden = false;
    const w = snapNote.offsetWidth;
    const left = rect ? rect.x + rect.width / 2 - w / 2 : window.innerWidth / 2 - w / 2;
    const top = rect ? rect.y + 14 : 80;
    snapNote.style.left = `${Math.round(clamp(left, 8, window.innerWidth - w - 8))}px`;
    snapNote.style.top = `${Math.round(top)}px`;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      snapNote.hidden = true;
    }, 2200);
  }
  /**
   * Режим снимка внутри выделения видео (клавиша снимка области или кнопка
   * «Снимок»): рамка становится жёлтой, её можно подвинуть или нарисовать
   * заново; Enter / та же клавиша — снять, Esc — назад к рамке видео.
   */
  const snapLayer = document.getElementById("snap-layer");
  let snapStarting = false;

  async function enterSnapMode() {
    if (snapMode || snapStarting) return;
    snapStarting = true;
    // Экран снимается как есть — с рамкой видео, кнопками и подсказкой; поверх
    // этого кадра выделяется снимок, как обычным «снимком области».
    const shot = await window.regionApi.snapBegin().catch((err) => ({ ok: false, error: err.message }));
    snapStarting = false;
    if (!shot?.ok) {
      showNote(I18N.t("Снимок не получился: {0}", shot?.error || shot?.reason || "?"), true);
      return;
    }
    snapLayer.src = shot.dataUrl;
    snapLayer.hidden = false;
    snapMode = true;
    videoRect = rect ? { ...rect } : null;
    rect = null;
    mode = "idle";
    document.body.classList.add("snap-mode");
    sel.classList.remove("on", "adjust", "busy");
    actions.hidden = true;
    hint.classList.remove("docked");
    hint.style.left = "";
    hint.style.top = "";
    setHint("snap", false);
  }

  function exitSnapMode() {
    if (!snapMode) return;
    snapMode = false;
    snapLayer.hidden = true;
    snapLayer.removeAttribute("src");
    window.regionApi.snapEnd?.();
    document.body.classList.remove("snap-mode");
    rect = videoRect ? { ...videoRect } : rect;
    videoRect = null;
    if (rect) {
      mode = "adjust";
      sel.classList.add("on", "adjust");
      actions.hidden = false;
      setHint("adjust", false);
      paint();
      requestAnimationFrame(() => rect && dock());
    } else {
      setHint("idle", false);
    }
  }

  async function takeSnap(copy = false) {
    if (!(mode === "adjust" && rect)) {
      setHint("need-draw", false);
      return;
    }
    sel.classList.remove("flash");
    void sel.offsetWidth;
    sel.classList.add("flash");
    const result = await window.regionApi.snap({ ...rect }, copy).catch((err) => ({ ok: false, error: err.message }));
    if (result?.ok) {
      exitSnapMode();
      showNote(copy ? I18N.t("Снимок рамки скопирован в буфер") : I18N.t("Снимок сохранён · {0} × {1}", result.width, result.height));
    } else {
      showNote(I18N.t("Снимок не получился: {0}", result?.error || result?.reason || "?"), true);
    }
  }

  if (intent === "video") {
    snapButton.hidden = false;
    const snapKey = document.getElementById("snap-key");
    if (shotKey) snapKey.textContent = shotKey;
    else snapKey.hidden = true;
    snapButton.addEventListener("click", () => void enterSnapMode());
    document.getElementById("snap-copy").addEventListener("click", () => void takeSnap(true));
    document.getElementById("snap-take").addEventListener("click", () => void takeSnap(false));
    document.getElementById("snap-back").addEventListener("click", () => exitSnapMode());
    const takeKey = document.getElementById("snap-take-key");
    if (takeKey && shotKey) takeKey.textContent = `Enter / ${shotKey}`;
    // Клавиша снимка: первое нажатие — режим снимка, второе — снять.
    window.regionApi.onSnapRequest?.(() => {
      if (!snapMode) void enterSnapMode();
      else if (mode === "adjust" && rect) void takeSnap(false);
    });
  }
  // Кнопка подписана той же клавишей, которой рамка подтверждается повторно.
  const acceptKey = document.getElementById("accept-key");
  if (acceptKey && hotkey) acceptKey.textContent = hotkey;

  // Повторный рендер динамических подписей при смене языка.
  function renderTexts() {
    document.getElementById("accept-label").textContent = acceptLabel();
    if (intent === "video") {
      for (const [value, label] of FORMATS) {
        const option = formatSelect.querySelector(`option[value="${value}"]`);
        if (option) option.textContent = formatText(value, label);
      }
    }
    renderHint();
    if (rect) dock();
  }

  window.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (snapMode) exitSnapMode();
    else done(null);
  });
})();
