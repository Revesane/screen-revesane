"use strict";

/**
 * Анимированный тур по программе: затемнение с «прожектором» на настоящих
 * элементах главного экрана, курсор-призрак, который сам кликает, тянет рамку
 * и проводит по кнопкам, и карточка с пояснением. Шаги листаются сами, как
 * GIF (пауза — наведением на карточку или кнопкой), и стрелками/кнопками.
 *
 * Тур ничего не нажимает по-настоящему: курсор и клики только нарисованы,
 * поэтому запустить его можно в любой момент без побочных эффектов.
 */

import { sceneHtml } from "./scenes.js";

const STEP_MS = 7500;

/** Карточка, в которой лежит элемент: подсвечиваем её целиком. */
const cardOf = (selector) => document.querySelector(selector)?.closest(".card") || null;

/**
 * target — что подсвечивать, point — куда «кликает» курсор (по умолчанию
 * центр target), demo — анимация курсора: click | drag | sweep | press | none.
 */
const STEPS = [
  {
    title: "Добро пожаловать!",
    text: "За минуту покажем, как здесь всё устроено. Тур можно пропустить и повторить позже в «Помощи».",
    demo: "none",
  },
  {
    target: () => document.getElementById("mode-select-btn"),
    title: "Что записывать",
    text: "Экран, окно, выделенная область, только звук или скриншот — режим выбирается здесь.",
    demo: "click",
  },
  {
    target: () => document.getElementById("mode-select-btn"),
    title: "Как записать область",
    text: "«Выделить и записать видео» ({2}): обведите область мышью, выберите формат и нажмите «Записать». Кнопки держатся рядом с рамкой.",
    demo: "none",
    scene: "region",
    ms: 11000,
  },
  {
    target: () => cardOf("#sel-source"),
    title: "Источник",
    text: "Какой монитор или окно записывать. В режиме области рамка рисуется мышью прямо на экране.",
    demo: "drag",
  },
  {
    target: () => cardOf("#sw-system"),
    point: () => document.getElementById("sw-system"),
    title: "Звук компьютера",
    text: "Всё, что слышно в колонках: игра, музыка, созвон. Полоска показывает, идёт ли звук.",
    demo: "click",
  },
  {
    target: () => cardOf("#sw-mic"),
    point: () => document.getElementById("sw-mic"),
    title: "Микрофон",
    text: "Ваш голос. Кнопка «Тест» покажет, слышит ли программа микрофон.",
    demo: "click",
  },
  {
    target: () => cardOf("#sw-webcam"),
    point: () => document.getElementById("sw-webcam"),
    title: "Веб-камера",
    text: "Картинка с камеры в углу видео. «Фото» — снимок с камеры с отсчётом.",
    demo: "click",
  },
  {
    target: () => document.getElementById("rec-panel"),
    point: () => document.getElementById("btn-primary"),
    title: "Запись",
    text: "Большая кнопка — старт и стоп. Клавиша {0} работает из любой программы, {1} — пауза.",
    demo: "press",
  },
  {
    target: () => document.querySelector(".quick"),
    title: "Быстрые настройки",
    text: "Авто-остановка, запись по расписанию, скрытие своего окна и формат файла — в один клик.",
    demo: "sweep",
  },
  {
    target: () => document.getElementById("strip-self"),
    title: "Своё окно: в кадре или скрыто",
    text: "«Скрыто» — окно Screen Revesane видно вам, но не попадает в видео: можно записывать экран и управлять программой. «В кадре» — окно снимается вместе со всем экраном.",
    demo: "none",
    scene: "self",
    ms: 8000,
  },
  {
    target: () => document.querySelector(".recent"),
    title: "Готовые записи",
    text: "Здесь появляются записи и снимки: открыть, подрезать, склеить или разметить.",
    demo: "click",
    pointAt: "head",
  },
  {
    target: () => document.getElementById("btn-compact"),
    title: "Компактный режим",
    text: "«⋯» в заголовке сворачивает окно в мини-пульт поверх всех окон: режимы одной иконкой, REC, формат, звук, снимок области. Вернуть обычное окно — стрелки в углу пульта.",
    demo: "none",
    scene: "compact",
    ms: 10000,
  },
  {
    target: () => document.querySelector('.rail-btn[data-view="settings"]'),
    title: "Настройки",
    text: "Формат и качество, звук, водяной знак, горячие клавиши и язык интерфейса.",
    demo: "click",
  },
  {
    target: () => document.getElementById("btn-theme"),
    title: "Темы оформления",
    text: "Палитра в заголовке окна — быстрый выбор из семи тем: Бирюза, Океан, Джунгли, Золото, Рубин, Лёд, Янтарь. Своя картинка фона — в Настройки → «Оформление».",
    demo: "none",
    scene: "themes",
    ms: 7500,
  },
  {
    target: () => document.getElementById("rail-state"),
    title: "Обновления",
    text: "Когда выйдет новая версия, здесь появится карточка с кнопкой «Обновить»: программа скачает установщик, проверит его и поставит. Проверить вручную — «О программе».",
    demo: "none",
    scene: "update",
    ms: 7000,
  },
  {
    target: () => document.querySelector('.rail-btn[data-view="help"]'),
    title: "Готово!",
    text: "Тур всегда можно повторить в «Помощи». Удачных записей!",
    demo: "click",
  },
];

const CURSOR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.2l13.6 8.1-6.1 1.3 3.6 6.7-2.6 1.4-3.6-6.8-4.5 4.3z"/></svg>';

function visibleRect(el) {
  if (!el || !el.isConnected) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return rect;
}

/**
 * @param {object} deps
 * @param {(name: string) => void} deps.showView переключить экран приложения
 * @param {() => {toggle?: string, pause?: string}} deps.hotkeys текущие клавиши
 * @param {(completed: boolean) => void} deps.onFinish тур закрыт
 */
export function createTour({ showView, hotkeys, onFinish }) {
  let root = null;
  let index = 0;
  let playing = true;
  // Тур после обновления: первый шаг говорит, до какой версии обновились.
  let updatedTo = "";
  let demoTimer = 0;
  let resizeHandler = null;
  let keyHandler = null;

  function build() {
    root = document.createElement("div");
    root.className = "tour";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
      <div class="tour-spot"></div>
      <div class="tour-cursor">${CURSOR_SVG}<span class="tour-ripple"></span></div>
      <div class="tour-drag"></div>
      <div class="tour-card" tabindex="-1">
        <div class="tour-top">
          <span class="tour-count"></span>
          <button class="tour-play" type="button"></button>
          <button class="tour-x" type="button">×</button>
        </div>
        <div class="tour-body">
          <div class="tour-hello"><span></span><span></span><span></span></div>
          <div class="tour-scene"></div>
          <h3 class="tour-title"></h3>
          <p class="tour-text"></p>
        </div>
        <div class="tour-progress"><span class="tour-progress-fill"></span></div>
        <div class="tour-foot">
          <button class="ghost small tour-skip" type="button"></button>
          <span class="grow"></span>
          <button class="ghost small tour-prev" type="button"></button>
          <button class="primary small tour-next" type="button"></button>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.querySelector(".tour-next").addEventListener("click", next);
    root.querySelector(".tour-prev").addEventListener("click", prev);
    root.querySelector(".tour-skip").addEventListener("click", () => close(false));
    root.querySelector(".tour-x").addEventListener("click", () => close(false));
    root.querySelector(".tour-play").addEventListener("click", () => {
      playing = !playing;
      paintChrome();
      restartProgress();
    });
    root.querySelector(".tour-progress-fill").addEventListener("animationend", () => {
      if (playing && index < STEPS.length - 1) next();
    });
    // Клик мимо карточки ничего не нажимает в приложении под туром.
    root.addEventListener("mousedown", (event) => {
      if (!event.target.closest(".tour-card")) event.preventDefault();
    });

    keyHandler = (event) => {
      if (event.key === "Escape") close(false);
      else if (event.key === "ArrowRight" || event.key === "Enter") next();
      else if (event.key === "ArrowLeft") prev();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", keyHandler, true);
    resizeHandler = () => layout(false);
    window.addEventListener("resize", resizeHandler);
  }

  function paintChrome() {
    const last = index === STEPS.length - 1;
    root.querySelector(".tour-count").textContent = `${index + 1} / ${STEPS.length}`;
    root.querySelector(".tour-prev").textContent = I18N.t("Назад");
    root.querySelector(".tour-prev").disabled = index === 0;
    root.querySelector(".tour-next").textContent = last ? I18N.t("Готово") : I18N.t("Далее");
    root.querySelector(".tour-skip").textContent = I18N.t("Пропустить");
    root.querySelector(".tour-skip").hidden = last;
    const play = root.querySelector(".tour-play");
    play.textContent = playing ? "❚❚" : "▶";
    play.title = playing ? I18N.t("Пауза") : I18N.t("Листать автоматически");
    play.hidden = last;
    root.querySelector(".tour-x").title = I18N.t("Закрыть");
    root.classList.toggle("is-paused", !playing);
  }

  /** Полоса времени шага: по её окончании тур листается дальше. */
  function restartProgress() {
    const fill = root.querySelector(".tour-progress-fill");
    fill.style.animation = "none";
    void fill.offsetWidth;
    fill.style.animation = "";
    // Длительность шага: у шагов-«видео» — один цикл их сцены.
    fill.style.animationDuration = `${STEPS[index].ms || STEP_MS}ms`;
    root.querySelector(".tour-progress").hidden = index === STEPS.length - 1;
  }

  function render() {
    const step = STEPS[index];
    const keys = hotkeys() || {};
    const body = root.querySelector(".tour-body");
    body.classList.remove("is-in");
    void body.offsetWidth;
    body.classList.add("is-in");
    const welcomeAfterUpdate = index === 0 && updatedTo;
    root.querySelector(".tour-title").textContent = welcomeAfterUpdate
      ? I18N.t("Программа обновлена до версии {0}", updatedTo)
      : I18N.t(step.title);
    root.querySelector(".tour-text").textContent = welcomeAfterUpdate
      ? I18N.t("Покажем, что где находится и что появилось нового. Тур можно пропустить и повторить позже в «Помощи».")
      : I18N.t(step.text, keys.toggle || "F9", keys.pause || "F8", keys.region || "F7");
    root.querySelector(".tour-hello").hidden = index !== 0;
    // Шаг-«видео»: мини-сцена крутится в карточке, шаг длится один её цикл.
    const sceneBox = root.querySelector(".tour-scene");
    sceneBox.innerHTML = step.scene ? sceneHtml(step.scene) : "";
    sceneBox.hidden = !step.scene;
    root.querySelector(".tour-card").classList.toggle("has-scene", Boolean(step.scene));
    paintChrome();
    restartProgress();
    layout(true);
    root.querySelector(".tour-card").focus({ preventScroll: true });
  }

  /** Расставить прожектор, карточку и курсор под текущий шаг. */
  function layout(animate) {
    if (!root) return;
    const step = STEPS[index];
    const target = visibleRect(step.target?.());
    const spot = root.querySelector(".tour-spot");
    const card = root.querySelector(".tour-card");
    const cursor = root.querySelector(".tour-cursor");
    const drag = root.querySelector(".tour-drag");
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;

    if (target) {
      spot.style.left = `${target.left - pad}px`;
      spot.style.top = `${target.top - pad}px`;
      spot.style.width = `${target.width + pad * 2}px`;
      spot.style.height = `${target.height + pad * 2}px`;
      spot.classList.remove("is-empty");
    } else {
      spot.style.left = `${vw / 2}px`;
      spot.style.top = `${vh / 2}px`;
      spot.style.width = "0px";
      spot.style.height = "0px";
      spot.classList.add("is-empty");
    }

    // Карточка: под целью, над ней, справа или слева — где помещается.
    const cw = card.offsetWidth || 340;
    const ch = card.offsetHeight || 200;
    const gap = 18;
    let left;
    let top;
    if (!target) {
      left = (vw - cw) / 2;
      top = (vh - ch) / 2;
    } else if (target.bottom + gap + ch < vh - 8) {
      left = target.left + target.width / 2 - cw / 2;
      top = target.bottom + gap;
    } else if (target.top - gap - ch > 8) {
      left = target.left + target.width / 2 - cw / 2;
      top = target.top - gap - ch;
    } else if (target.right + gap + cw < vw - 8) {
      left = target.right + gap;
      top = target.top + target.height / 2 - ch / 2;
    } else {
      left = target.left - gap - cw;
      top = target.top + target.height / 2 - ch / 2;
    }
    card.style.left = `${Math.round(Math.max(12, Math.min(left, vw - cw - 12)))}px`;
    card.style.top = `${Math.round(Math.max(12, Math.min(top, vh - ch - 12)))}px`;

    // Курсор: подлетает к точке, потом крутит свою анимацию по кругу.
    clearTimeout(demoTimer);
    root.dataset.demo = "";
    drag.style.opacity = "0";
    if (!target || step.demo === "none") {
      cursor.classList.add("is-hidden");
      return;
    }
    cursor.classList.remove("is-hidden");
    const pointRect = visibleRect(step.point?.()) || target;
    let x = pointRect.left + pointRect.width / 2;
    let y = pointRect.top + pointRect.height / 2;
    if (step.pointAt === "head") y = pointRect.top + Math.min(26, pointRect.height / 2);
    if (step.demo === "drag") {
      x = target.left + target.width * 0.18;
      y = target.top + target.height * 0.42;
      const dx = target.width * 0.62;
      const dy = target.height * 0.36;
      root.style.setProperty("--dx", `${Math.round(dx)}px`);
      root.style.setProperty("--dy", `${Math.round(dy)}px`);
      drag.style.left = `${Math.round(x)}px`;
      drag.style.top = `${Math.round(y)}px`;
      drag.style.width = `${Math.round(dx)}px`;
      drag.style.height = `${Math.round(dy)}px`;
    } else if (step.demo === "sweep") {
      x = target.left + 30;
      root.style.setProperty("--dx", `${Math.round(target.width - 80)}px`);
      root.style.setProperty("--dy", "0px");
    }
    cursor.style.left = `${Math.round(x)}px`;
    cursor.style.top = `${Math.round(y)}px`;
    demoTimer = setTimeout(
      () => {
        if (!root) return;
        root.dataset.demo = step.demo;
        if (step.demo === "drag") drag.style.opacity = "";
      },
      animate ? 650 : 0,
    );
  }

  function next() {
    if (index >= STEPS.length - 1) {
      close(true);
      return;
    }
    index += 1;
    render();
  }

  function prev() {
    if (index === 0) return;
    index -= 1;
    render();
  }

  function close(completed) {
    if (!root) return;
    clearTimeout(demoTimer);
    window.removeEventListener("keydown", keyHandler, true);
    window.removeEventListener("resize", resizeHandler);
    const el = root;
    root = null;
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 260);
    onFinish?.(completed);
  }

  /** @param {{updatedTo?: string}} [opts] updatedTo — тур после обновления */
  function start(opts = {}) {
    if (root) return;
    updatedTo = String(opts.updatedTo || "");
    showView("capture");
    document.getElementById("mode-menu")?.setAttribute("hidden", "");
    index = 0;
    playing = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    build();
    // Курсор стартует из центра окна, а не из угла.
    const cursor = root.querySelector(".tour-cursor");
    cursor.style.left = `${window.innerWidth / 2}px`;
    cursor.style.top = `${window.innerHeight / 2}px`;
    requestAnimationFrame(() => {
      root?.classList.add("is-open");
      render();
    });
  }

  return {
    start,
    close: () => close(false),
    isOpen: () => Boolean(root),
    /** Перевести открытый тур после смены языка. */
    relocalize: () => {
      if (root) render();
    },
    stepMs: STEP_MS,
  };
}
