"use strict";
// Тема ставится до первой отрисовки: main передаёт её в адресе окна (?theme=),
// иначе окно на долю секунды мелькало бы бирюзовым перед загрузкой настроек.
(() => {
  const theme = new URLSearchParams(window.location.search).get("theme");
  if (/^[a-z]+$/.test(theme || "")) document.documentElement.dataset.theme = theme;
})();
