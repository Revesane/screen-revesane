"use strict";

// Интернационализация без зависимостей: UMD-модуль для main (require) и окон
// (classic script). Ключи — точные русские строки; en.js хранит переводы.
// Разметка: data-i18n="текст" (textContent), data-i18n-placeholder/title/
// aria-label/alt="текст" (атрибуты). Динамические строки: I18N.t("текст {0}", x).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./en.js"));
  else root.I18N = factory(root.I18N_EN || {});
})(typeof self !== "undefined" ? self : globalThis, function (en) {
  "use strict";

  let lang = "ru";

  function setLang(next) {
    lang = next === "en" ? "en" : "ru";
    if (typeof document !== "undefined" && document.documentElement) document.documentElement.lang = lang;
  }

  // Окна открываются с ?lang=…: язык известен до первого скрипта интерфейса,
  // поэтому подсказки, которые ставятся при загрузке, сразу на нужном языке.
  if (typeof location !== "undefined" && location.search) {
    try {
      setLang(new URLSearchParams(location.search).get("lang"));
    } catch {
      /* без query остаётся русский */
    }
  }

  function getLang() {
    return lang;
  }

  function t(key, ...args) {
    let text = lang === "en" && Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key;
    if (args.length) text = String(text).replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
    return text;
  }

  const ATTRS = ["placeholder", "title", "aria-label", "alt"];

  function applyDom(rootEl) {
    const scope = rootEl || document;
    for (const el of scope.querySelectorAll("[data-i18n]")) {
      el.textContent = t(el.getAttribute("data-i18n"));
    }
    for (const attr of ATTRS) {
      for (const el of scope.querySelectorAll(`[data-i18n-${attr}]`)) {
        // Составная подсказка: data-i18n-title="{0}: …" + data-i18n-title-args='["ключ"]'.
        let args = [];
        try {
          args = JSON.parse(el.getAttribute(`data-i18n-${attr}-args`) || "[]");
        } catch {
          args = [];
        }
        el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`), ...args.map((arg) => t(String(arg)))));
      }
    }
  }

  return { t, setLang, getLang, applyDom };
});