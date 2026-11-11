"use strict";

/**
 * Рамка записываемой области: тонкий контур + пульсирующий значок REC с
 * таймером. Окно исключено из захвата, клики проходят сквозь него — здесь
 * только индикация, управление остаётся на горячих клавишах и главном окне.
 */
(() => {
  const qs = new URLSearchParams(location.search);
  I18N.setLang(qs.get("lang") === "en" ? "en" : "ru");
  I18N.applyDom();
  // Динамические подписи рамки — числа (таймер, размер) и имя контейнера,
  // они не переводятся; при смене языка достаточно обновить разметку.
  window.frameApi.onLang((lang) => {
    I18N.setLang(lang);
    I18N.applyDom();
  });

  const params = new URLSearchParams(location.search);
  const width = Number(params.get("w")) || 0;
  const height = Number(params.get("h")) || 0;

  const size = document.getElementById("size");
  if (width && height) size.textContent = `${Math.round(width)}×${Math.round(height)}`;

  // Формат записи рядом с таймером: значок исключён из захвата, поэтому в
  // видео он не попадёт.
  const format = String(params.get("format") || "").trim();
  if (format) document.getElementById("format").textContent = format;

  // Тесная область: значок должен остаться читаемым, но не заслонить кадр.
  if (Math.min(window.innerWidth, window.innerHeight) < 130) document.body.classList.add("tiny");
  if (window.innerWidth < 260) document.body.classList.add("narrow");

  const timer = document.getElementById("timer");
  const formatClock = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
  };

  window.frameApi.onState((state) => {
    if (!state) return;
    timer.textContent = formatClock(Number(state.elapsedMs) || 0);
    document.body.classList.toggle("paused", Boolean(state.paused));
  });
})();
