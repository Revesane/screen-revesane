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
  const hotkey = String(query.get("hotkey") || "").trim();
  const confirmKey = hotkey || "Enter";
  const ACCEPT_LABEL = intent === "shot" ? "Снимок" : "Записать";
  const CONFIRM_WORD = intent === "shot" ? "снимок" : "записать";
  const HINT_IDLE = `Тяните рамку мышью · <b>Esc</b> — отмена`;
  // Главное, чего не хватало: явно сказать, что рамку надо подтвердить.
  const HINT_ADJUST =
    `Тяните края, ✛ переносит · <kbd>${confirmKey}</kbd> — ${CONFIRM_WORD}` +
    `<br><span class="hint-sub">или кнопка «${ACCEPT_LABEL}» внизу` +
    (intent === "video"
      ? " · Esc — отмена</span>"
      : " · <kbd>Ctrl</kbd>+<kbd>C</kbd> — в буфер · Esc — отмена</span>") +
    // Подсказка на случай «куда пропало моё окно»: при включённой защите
    // приложение не попадает ни в подложку, ни в запись.
    (query.get("selfHidden") === "1"
      ? `<br><span class="hint-sub">окно Screen Revesane не попадёт в кадр — включите «Своё окно: в кадре» на главной</span>`
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
  if (intent === "video") {
    for (const [value, label] of FORMATS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
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
  }

  function setHint(html, dim) {
    hint.innerHTML = html;
    hint.style.opacity = dim ? "0.35" : "1";
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
    setHint(HINT_ADJUST, false);
    paint();
  }

  window.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
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
    if (mode === "adjust" && (event.target.closest?.("#move") || inside({ x: event.clientX, y: event.clientY }))) {
      moveOffset = { x: event.clientX - rect.x, y: event.clientY - rect.y };
      mode = "move";
      sel.classList.add("busy");
      return;
    }
    // Иначе начинаем новую рамку.
    mode = "draw";
    anchor = { x: event.clientX, y: event.clientY };
    sel.classList.remove("adjust", "busy");
    setHint(HINT_IDLE, true);
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
    if (mode === "draw") {
      if (!rect || rect.width < MIN_SIDE || rect.height < MIN_SIDE) {
        rect = null;
        sel.classList.remove("on", "adjust");
        setHint(HINT_IDLE, false);
        mode = "idle";
        return;
      }
      startAdjust();
      return;
    }
    if (mode === "resize" || mode === "move") {
      sel.classList.remove("busy");
      mode = "adjust";
      setHint(HINT_ADJUST, false);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      done(null);
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
    if (mode === "adjust" && rect) done(rect);
  });
  // Горячая клавиша «выделить и записать видео», нажатая второй раз, подтверждает
  // рамку: не нужно тянуться к Enter или кнопке. Если рамки ещё нет — говорим,
  // что делать, вместо молчаливого игнорирования.
  window.regionApi.onConfirm?.(() => {
    if (mode === "adjust" && rect) {
      done(rect);
      return;
    }
    hint.innerHTML = `Сначала выделите рамку мышью, потом нажмите клавишу ещё раз`;
    hint.style.opacity = "1";
  });
  document.getElementById("copy").addEventListener("click", () => {
    if (mode === "adjust" && rect) done({ ...rect, copy: true });
  });
  document.getElementById("cancel").addEventListener("click", () => done(null));

  // Подпись меняем только у надписи: бейдж <kbd>Enter</kbd> внутри кнопки
  // должен остаться на месте.
  document.getElementById("accept-label").textContent = ACCEPT_LABEL;
  // Кнопка подписана той же клавишей, которой рамка подтверждается повторно.
  const acceptKey = document.getElementById("accept-key");
  if (acceptKey && hotkey) acceptKey.textContent = hotkey;

  window.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    done(null);
  });
})();
