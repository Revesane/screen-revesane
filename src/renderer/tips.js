"use strict";

/**
 * Умные подсказки: короткие советы по ситуации («системный звук молчит»,
 * «микрофон перегружен», «мало места на диске»…). Правила живут в app.js —
 * здесь только показ, очередь и память о том, что уже показывали.
 *
 * Каждая подсказка показывается не чаще раза за запуск; «Больше не
 * показывать» запоминается в настройках (tipsDismissed). Всё считается
 * локально — ничего не уходит в сеть.
 */

const BULB_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/></svg>';

const VISIBLE_MS = 14000;
/** Пауза между подсказками: не засыпать человека советами подряд. */
const GAP_MS = 20000;

/**
 * @param {object} deps
 * @param {() => object} deps.settings текущие настройки
 * @param {(patch: object) => Promise<void>} deps.save сохранить настройки
 * @param {() => boolean} deps.blocked сейчас показывать нельзя (идёт тур)
 */
export function createTips({ settings, save, blocked }) {
  const shown = new Set();
  let current = null;
  let hideTimer = 0;
  let lastShownAt = 0;

  function enabled() {
    return settings()?.smartTips !== false;
  }

  function dismissed(id) {
    const list = settings()?.tipsDismissed;
    return Array.isArray(list) && list.includes(id);
  }

  /** Можно ли сейчас показать подсказку id (для правил, которым дорого считать). */
  function canShow(id) {
    return enabled() && !shown.has(id) && !dismissed(id) && !blocked?.();
  }

  function hide() {
    clearTimeout(hideTimer);
    if (!current) return;
    const el = current;
    current = null;
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 240);
  }

  /**
   * Показать подсказку.
   * @param {string} id постоянный идентификатор правила
   * @param {string} key русский ключ текста (I18N)
   * @param {object} [opts]
   * @param {Array} [opts.args] аргументы текста
   * @param {{label: string, run: () => void}} [opts.action] кнопка действия
   * @param {boolean} [opts.urgent] показать, даже если недавно была другая
   * @param {boolean} [opts.once] показать один раз навсегда
   */
  function show(id, key, opts = {}) {
    if (!canShow(id)) return false;
    if (!opts.urgent && Date.now() - lastShownAt < GAP_MS) return false;
    shown.add(id);
    lastShownAt = Date.now();
    hide();
    // Разовые подсказки («первая запись») запоминаются сразу при показе.
    if (opts.once) {
      const list = Array.isArray(settings()?.tipsDismissed) ? settings().tipsDismissed : [];
      void save({ tipsDismissed: [...new Set([...list, id])] });
    }

    const el = document.createElement("div");
    el.className = "smart-tip";
    el.setAttribute("role", "status");
    el.innerHTML = `
      <span class="tip-bulb">${BULB_SVG}</span>
      <div class="tip-main">
        <div class="tip-head"><span class="tip-label"></span><button class="tip-close" type="button">×</button></div>
        <div class="tip-text"></div>
        <div class="tip-actions"></div>
      </div>
      <span class="tip-timer"></span>`;
    el.querySelector(".tip-label").textContent = I18N.t("Совет");
    el.querySelector(".tip-text").textContent = I18N.t(key, ...(opts.args || []));
    el.querySelector(".tip-close").title = I18N.t("Закрыть");
    el.querySelector(".tip-close").addEventListener("click", hide);

    const actions = el.querySelector(".tip-actions");
    if (opts.action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost small";
      button.textContent = I18N.t(opts.action.label);
      button.addEventListener("click", () => {
        hide();
        opts.action.run();
      });
      actions.appendChild(button);
    }
    const never = document.createElement("button");
    never.type = "button";
    never.className = "tip-never";
    never.textContent = I18N.t("Больше не показывать");
    never.addEventListener("click", () => {
      hide();
      const list = Array.isArray(settings()?.tipsDismissed) ? settings().tipsDismissed : [];
      void save({ tipsDismissed: [...new Set([...list, id])] });
    });
    actions.appendChild(never);

    // Таймер скрытия стоит, пока на подсказку наведена мышь.
    const arm = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, VISIBLE_MS);
    };
    el.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    el.addEventListener("mouseleave", arm);
    el.querySelector(".tip-timer").addEventListener("animationend", hide);

    document.body.appendChild(el);
    current = el;
    arm();
    return true;
  }

  return { show, hide, canShow };
}
