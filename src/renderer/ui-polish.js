// Полировка интерфейса: единые подсказки, состояния переключателей для
// клавиатуры и экранных дикторов, управление списком режимов, «тик» отсчёта.
//
// Файл ничего не знает о записи и не трогает состояние приложения: он только
// читает DOM и добавляет атрибуты/классы. Если его не загрузить, приложение
// работает как раньше (теряются лишь подсказки и клавиатурные удобства).

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ───────────────────────────────────────────── подсказки

  /** Пояснения к кнопкам, у которых нет собственной подсказки. */
  const TITLES = {
    "btn-primary": "Начать или остановить запись",
    "btn-pause": "Приостановить или продолжить запись",
    "mode-select-btn": "Что записывать: экран, окно, область, звук или скриншот",
    "sel-source": "Какой экран или окно записывать",
    "btn-pick-region": "Выбрать область экрана для записи",
    "btn-camera-test": "Включить камеру и посмотреть кадр",
    "btn-camera-photo": "Сделать снимок с камеры (отсчёт 3 с)",
    "btn-mic-test": "Проверить микрофон — покажет уровень сигнала",
    "btn-recent-all": "Открыть полную историю записей",
    "btn-recent-clear": "Удалить записи и снимки из папки (спросит подтверждение)",
    "mic-db": "Уровень сигнала микрофона",
    "system-meter": "Уровень системного звука",
    "mic-level": "Уровень сигнала микрофона",
    timer: "Длительность текущей записи",
  };

  /** Почему кнопка сейчас недоступна: [причина, обычная подсказка]. */
  const DISABLED_WHY = {
    "mode-select-btn": ["Во время записи режим менять нельзя", TITLES["mode-select-btn"]],
    "btn-merge": ["Отметьте минимум две записи", "Склеить выбранные записи в одну"],
    "btn-panorama": ["Отметьте минимум два снимка", "Собрать панораму из выбранных снимков"],
  };

  /** Элементы, текст которых может обрезаться: подсказка покажет его целиком. */
  const OVERFLOW_SELECTOR = ".card-status, .recent-name, .row-name, .dir-path, .wm-file";

  for (const [id, text] of Object.entries(TITLES)) {
    const el = $(id);
    if (el && !el.title) el.title = text;
  }

  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);

  let tipOwner = null; // элемент, чей title сейчас спрятан
  let tipText = "";
  let showTimer = 0;

  function place(el) {
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function hide() {
    clearTimeout(showTimer);
    tip.classList.remove("is-shown");
    if (tipOwner) {
      // Возвращаем title: без подсказки он нужен экранным дикторам.
      if (!tipOwner.title) tipOwner.title = tipText;
      tipOwner = null;
    }
  }

  function arm(el, text, delay) {
    hide();
    tipOwner = el;
    tipText = text;
    el.removeAttribute("title"); // иначе рядом всплывёт системная подсказка
    showTimer = setTimeout(() => {
      tip.textContent = tipText;
      place(el);
      tip.classList.add("is-shown");
    }, delay);
  }

  function tipFor(el) {
    const own = el.closest("[title]");
    if (own && own.title && !own.disabled) return [own, own.title];
    const clipped = el.closest(OVERFLOW_SELECTOR);
    if (clipped && clipped.scrollWidth > clipped.clientWidth + 1) {
      return [clipped, clipped.textContent.trim()];
    }
    return null;
  }

  document.addEventListener("pointerover", (event) => {
    if (event.pointerType === "touch") return;
    const found = event.target instanceof Element ? tipFor(event.target) : null;
    if (!found) return;
    if (found[0] === tipOwner) return;
    arm(found[0], found[1], 420);
  });
  document.addEventListener("pointerout", (event) => {
    if (tipOwner && !tipOwner.contains(event.relatedTarget)) hide();
  });
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);

  // С клавиатуры подсказка появляется сразу вместе с фокусом.
  document.addEventListener("focusin", (event) => {
    const el = event.target;
    if (!(el instanceof Element) || !el.matches(":focus-visible")) return;
    const found = tipFor(el);
    if (found) arm(found[0], found[1], 0);
  });
  document.addEventListener("focusout", hide);

  /** Записать подсказку, не мешая той, что показана прямо сейчас. */
  function setTitle(el, text) {
    if (tipOwner === el) {
      tipText = text;
      tip.textContent = text;
    } else {
      el.title = text;
    }
  }

  // ───────────────────────────────────────────── переключатели

  function syncSwitch(sw) {
    const on = sw.classList.contains("is-on");
    sw.setAttribute("aria-checked", String(on));
    const name =
      sw.closest(".card")?.querySelector(".card-title")?.textContent.trim() ||
      sw.querySelector(".switch-name")?.textContent.trim() ||
      "";
    const state = on ? "включено" : "выключено";
    const action = on ? "выключить" : "включить";
    setTitle(sw, name ? `${name}: ${state}. Нажмите, чтобы ${action}` : `${state[0].toUpperCase()}${state.slice(1)}. Нажмите, чтобы ${action}`);
  }

  document.querySelectorAll(".switch").forEach((sw) => {
    sw.setAttribute("role", "switch");
    syncSwitch(sw);
    new MutationObserver(() => syncSwitch(sw)).observe(sw, { attributes: true, attributeFilter: ["class"] });
  });

  // ───────────────────────────────────────────── причины недоступности

  for (const [id, [why, normal]] of Object.entries(DISABLED_WHY)) {
    const el = $(id);
    if (!el) continue;
    const sync = () => setTitle(el, el.disabled ? why : normal);
    sync();
    new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ["disabled"] });
  }

  // ───────────────────────────────────────────── навигация и состояние

  document.querySelectorAll(".rail-btn").forEach((btn) => {
    const sync = () => {
      if (btn.classList.contains("is-active")) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    };
    sync();
    new MutationObserver(sync).observe(btn, { attributes: true, attributeFilter: ["class"] });
  });

  // Смена статусов слышна экранному диктору, не перехватывая фокус.
  for (const id of ["status", "toast", "rail-state-text"]) {
    const el = $(id);
    if (el) el.setAttribute("aria-live", "polite");
  }

  // Клик по уведомлению закрывает его.
  const toastEl = $("toast");
  if (toastEl) {
    toastEl.title = "Нажмите, чтобы закрыть";
    toastEl.addEventListener("click", () => {
      toastEl.hidden = true;
    });
  }

  // ───────────────────────────────────────────── список режимов с клавиатуры

  const modeBtn = $("mode-select-btn");
  const modeMenu = $("mode-menu");
  if (modeBtn && modeMenu) {
    modeBtn.setAttribute("aria-haspopup", "menu");
    modeBtn.setAttribute("aria-expanded", "false");
    modeMenu.setAttribute("role", "menu");
    modeMenu.querySelectorAll(".preset").forEach((item) => item.setAttribute("role", "menuitem"));

    const items = () => [...modeMenu.querySelectorAll(".preset:not([hidden]):not(:disabled)")];
    let openedByKeyboard = false;

    modeBtn.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") openedByKeyboard = true;
    });
    modeBtn.addEventListener("pointerdown", () => {
      openedByKeyboard = false;
    });

    new MutationObserver(() => {
      const open = !modeMenu.hidden;
      modeBtn.setAttribute("aria-expanded", String(open));
      if (open && openedByKeyboard) {
        (modeMenu.querySelector(".preset.is-active") || items()[0])?.focus();
      }
    }).observe(modeMenu, { attributes: true, attributeFilter: ["hidden"] });

    // ArrowDown на закрытой кнопке открывает список.
    modeBtn.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && modeMenu.hidden && !modeBtn.disabled) {
        event.preventDefault();
        modeMenu.hidden = false;
      }
    });

    modeMenu.addEventListener("keydown", (event) => {
      const list = items();
      const at = list.indexOf(document.activeElement);
      let next = -1;
      if (event.key === "ArrowDown") next = (at + 1) % list.length;
      else if (event.key === "ArrowUp") next = (at - 1 + list.length) % list.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = list.length - 1;
      if (next >= 0) {
        event.preventDefault();
        list[next]?.focus();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || modeMenu.hidden) return;
      modeMenu.hidden = true;
      if (modeMenu.contains(document.activeElement)) modeBtn.focus();
    });
  }

  // ───────────────────────────────────────────── отсчёт: «тик» на каждую цифру

  const countNum = $("countdown-num");
  if (countNum) {
    new MutationObserver(() => {
      countNum.classList.remove("tick");
      void countNum.offsetWidth; // перезапуск анимации
      countNum.classList.add("tick");
    }).observe(countNum, { childList: true, characterData: true, subtree: true });
  }
})();
