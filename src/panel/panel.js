"use strict";

(() => {
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

  window.panelApi.onState((state) => {
    if (!state) return;
    timer.textContent = formatClock(Number(state.elapsedMs) || 0);
    label.textContent = state.paused ? "пауза" : "запись";
    lamp.classList.toggle("paused", Boolean(state.paused));
  });

  document.getElementById("pause").addEventListener("click", () => window.panelApi.command("pause"));
  document.getElementById("stop").addEventListener("click", () => window.panelApi.command("stop"));
})();
