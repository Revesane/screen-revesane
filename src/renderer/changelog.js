"use strict";

/**
 * «Что нового»: список изменений по версиям и окно, которое показывается
 * после каждого обновления. Ключи — русские строки, переводы в src/i18n/en.js.
 * Новые версии добавляются в начало CHANGELOG.
 */

export const CHANGELOG = [
  {
    version: "0.3.5",
    items: [
      "Редактор: масштаб предпросмотра «1:1» — кадр пиксель в пиксель, как на мониторе; текст больше не мылится от масштабирования окна.",
      "Редактор: если масштаб окна близок к родному, режим 1:1 с прокруткой включается сам; кнопка «Вписать» возвращает обзор целиком.",
      "Редактор: в полном экране кадр больше не обрезается снизу — «Вписать» показывает запись целиком.",
    ],
  },
  {
    version: "0.3.4",
    items: [
      "После каждого обновления появляется окно «Что нового» с описанием изменений новой версии.",
      "Список изменений можно открыть снова в любой момент: «О программе» → «Что нового».",
    ],
  },
  {
    version: "0.3.3",
    items: [
      "Исправлена запись видео: экспериментальный движок WebCodecs отключён — файлы снова содержат все кадры.",
      "Исправлена ошибка, из-за которой запись могла не начаться из-за двойного старта рекордера.",
    ],
  },
  {
    version: "0.3.0",
    items: [
      "Новый раздел настроек «Дополнительно»: разрешение видео, битрейт, энкодер H.264, частота кадров, качество записи и скриншотов.",
      "Финальное видео перекодируется в H.264 High (CRF 16) для максимального качества; аппаратные NVENC/QSV ускоряют перекод.",
      "Экран пишется в родном разрешении монитора; доступны пресеты 16:9 и 1080p/1440p.",
      "Качество скриншотов JPEG регулируется, PNG всегда без потерь.",
    ],
  },
  {
    version: "0.2.6",
    items: ["Исправлено копирование снимков в буфер обмена."],
  },
  {
    version: "0.2.5",
    items: ["Трей, автозапуск вместе с Windows, рамки записи в цветах темы."],
  },
  {
    version: "0.2.4",
    items: ["Темы оформления, снимок поверх записи, новый компактный режим."],
  },
  {
    version: "0.2.3",
    items: ["Тур по программе, умные подсказки, автоматические обновления."],
  },
  {
    version: "0.2.2",
    items: ["Английский интерфейс и выбор языка."],
  },
];

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/**
 * @param {object} deps
 * @param {() => void} deps.onClose окно закрыто (кнопкой, крестиком или Escape)
 */
export function createWhatsNew({ onClose }) {
  let root = null;
  let shownVersion = "";
  let keyHandler = null;

  function sectionHtml(entry, current) {
    const items = entry.items.map((item) => `<li>${escapeHtml(I18N.t(item))}</li>`).join("");
    const mark = current ? `<span class="whatsnew-now">${escapeHtml(I18N.t("установлена"))}</span>` : "";
    return `<section class="whatsnew-ver${current ? " is-current" : ""}"><h4>${escapeHtml(entry.version)}${mark}</h4><ul>${items}</ul></section>`;
  }

  function listHtml() {
    const sections = [];
    // Версии без записи в списке (например, сборка из исходников) — общая строка.
    if (shownVersion && !CHANGELOG.some((entry) => entry.version === shownVersion)) {
      sections.push(sectionHtml({ version: shownVersion, items: ["Внутренние улучшения и исправления."] }, true));
    }
    for (const entry of CHANGELOG) sections.push(sectionHtml(entry, entry.version === shownVersion));
    return sections.join("");
  }

  function paint() {
    root.querySelector(".whatsnew-badge").textContent = `v${shownVersion}`;
    root.querySelector(".whatsnew-title").textContent = I18N.t("Что нового в версии {0}", shownVersion);
    root.querySelector(".whatsnew-list").innerHTML = listHtml();
    root.querySelector(".whatsnew-ok").textContent = I18N.t("Понятно");
    root.querySelector(".whatsnew-x").title = I18N.t("Закрыть");
  }

  function build() {
    root = document.createElement("div");
    root.className = "whatsnew";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML = `
      <div class="whatsnew-card" tabindex="-1">
        <div class="whatsnew-top">
          <span class="whatsnew-badge"></span>
          <button class="whatsnew-x" type="button">×</button>
        </div>
        <h3 class="whatsnew-title"></h3>
        <div class="whatsnew-list"></div>
        <div class="whatsnew-foot">
          <span class="grow"></span>
          <button class="primary small whatsnew-ok" type="button"></button>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.querySelector(".whatsnew-ok").addEventListener("click", close);
    root.querySelector(".whatsnew-x").addEventListener("click", close);
    // Клик по затемнённому фону закрывает окно; приложение под ним не трогаем.
    root.addEventListener("mousedown", (event) => {
      if (!event.target.closest(".whatsnew-card")) close();
    });

    keyHandler = (event) => {
      if (event.key !== "Escape" && event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", keyHandler, true);
  }

  function close() {
    if (!root) return;
    window.removeEventListener("keydown", keyHandler, true);
    const el = root;
    root = null;
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 260);
    onClose?.();
  }

  /** @param {{version?: string}} [opts] версия, о которой рассказываем */
  function open(opts = {}) {
    if (root) return;
    shownVersion = String(opts.version || CHANGELOG[0]?.version || "");
    build();
    paint();
    requestAnimationFrame(() => {
      root?.classList.add("is-open");
      root?.querySelector(".whatsnew-card").focus({ preventScroll: true });
    });
  }

  return {
    open,
    close,
    isOpen: () => Boolean(root),
    /** Перевести открытое окно после смены языка. */
    relocalize: () => {
      if (root) paint();
    },
  };
}