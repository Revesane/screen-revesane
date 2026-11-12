"use strict";

(() => {
  const qs = new URLSearchParams(location.search);
  I18N.setLang(qs.get("lang") === "en" ? "en" : "ru");
  // Акцент выбранной темы — как у главного окна.
  if (/^\d{1,3} \d{1,3} \d{1,3}$/.test(qs.get("accent") || "")) {
    document.documentElement.style.setProperty("--acc", qs.get("accent"));
  }
  I18N.applyDom();
  window.panelApi.onLang((lang) => {
    I18N.setLang(lang);
    I18N.applyDom();
    renderState();
  });

  const timer = document.getElementById("timer");
  const label = document.getElementById("label");
  const lamp = document.getElementById("lamp");

  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  window.panelApi.onStyle((style) => {
    document.body.classList.toggle("ball", style === "ball");
  });

  // Последнее состояние храним, чтобы при смене языка перерисовать подпись.
  let lastState = null;

  function renderState() {
    if (!lastState) return;
    timer.textContent = formatClock(Number(lastState.elapsedMs) || 0);
    label.textContent = lastState.paused ? I18N.t("Пауза") : I18N.t("запись");
    lamp.classList.toggle("paused", Boolean(lastState.paused));
  }

  window.panelApi.onState((state) => {
    if (!state) return;
    lastState = state;
    renderState();
  });

  document.getElementById("pause").addEventListener("click", () => window.panelApi.command("pause"));
  document.getElementById("shot").addEventListener("click", () => window.panelApi.command("regionShot"));
  document.getElementById("stop").addEventListener("click", () => window.panelApi.command("stop"));
})();
