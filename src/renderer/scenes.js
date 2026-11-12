"use strict";

/**
 * Анимированные мини-сцены для тура и «Помощи»: маленькие «видео» на CSS,
 * которые крутятся по кругу. Разметка здесь, движение — в guide.css
 * (классы .scene-*). Подписи идут через I18N, поэтому сцену пересобирают
 * при смене языка.
 */

const CURSOR =
  '<svg class="sc-cursor-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.2l13.6 8.1-6.1 1.3 3.6 6.7-2.6 1.4-3.6-6.8-4.5 4.3z"/></svg>';

const t = (key, ...args) => I18N.t(key, ...args);

/** Выделение области → выбор формата → «Записать» → идёт запись. */
function regionScene() {
  return `
    <div class="scene scene-region" aria-hidden="true">
      <div class="sc-desk">
        <i class="sc-win w1"></i><i class="sc-win w2"></i><i class="sc-win w3"></i>
      </div>
      <div class="sc-dim"></div>
      <div class="sc-hint">${t("Тяните края · Enter — записать")}</div>
      <div class="sc-sel"><span class="sc-size">1280 × 720</span></div>
      <div class="sc-bar">
        <span class="sc-fmt"><b class="f1">MP4</b><b class="f2">GIF</b> ▾</span>
        <span class="sc-rec"><i></i>${t("Записать")}</span>
        <span class="sc-cancel">${t("Отмена")}</span>
      </div>
      <div class="sc-menu"><span>MP4</span><span>WebM</span><span class="pick">GIF</span><span>MKV</span></div>
      <div class="sc-live"><i></i>REC <b class="n1">00:01</b><b class="n2">00:02</b><b class="n3">00:03</b></div>
      <div class="sc-cursor">${CURSOR}<span class="sc-click"></span></div>
      <div class="sc-caption">
        <span class="c1">${t("1. Обведите область мышью")}</span>
        <span class="c2">${t("2. Выберите формат: MP4, WebM, GIF…")}</span>
        <span class="c3">${t("3. «Записать» — пошла запись")}</span>
      </div>
    </div>`;
}

/** «Своё окно»: вы видите окно программы, а запись — нет. */
function selfScene() {
  return `
    <div class="scene scene-self" aria-hidden="true">
      <div class="sc-col left">
        <span class="sc-label">${t("Ваш экран")}</span>
        <div class="sc-screen">
          <i class="sc-win w1"></i>
          <div class="sc-app"><i></i><i></i><i class="r"></i></div>
        </div>
      </div>
      <div class="sc-arrow">→</div>
      <div class="sc-col right">
        <span class="sc-label">${t("Что попадёт в запись")}</span>
        <div class="sc-screen sc-out">
          <i class="sc-win w1"></i>
          <div class="sc-app"><i></i><i></i><i class="r"></i></div>
          <span class="sc-ghost">${t("окна нет")}</span>
        </div>
      </div>
      <div class="sc-toggle"><span class="s1">${t("Своё окно: в кадре")}</span><span class="s2">${t("Своё окно: скрыто")}</span></div>
      <div class="sc-cursor">${CURSOR}<span class="sc-click"></span></div>
      <div class="sc-caption">
        <span class="k1">${t("«В кадре» — окно программы попадает в видео")}</span>
        <span class="k2">${t("«Скрыто» — вы окно видите, а в записи его нет")}</span>
      </div>
    </div>`;
}

/** Темы: мини-интерфейс перекрашивается, рамка выбора бежит по плиткам. */
function themesScene() {
  return `
    <div class="scene scene-themes" aria-hidden="true">
      <div class="sc-bg b1"></div><div class="sc-bg b2"></div><div class="sc-bg b3"></div><div class="sc-bg b4"></div><div class="sc-bg b5"></div>
      <div class="sc-ui"><i></i><i></i><i></i><i class="r"></i></div>
      <div class="sc-tiles"><i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="b4"></i><i class="b5"></i><span class="sc-ring"></span></div>
    </div>`;
}

/** Обновление: «Обновить» → скачивание → «Установить» → готово. */
function updateScene() {
  return `
    <div class="scene scene-update" aria-hidden="true">
      <div class="sc-card">
        <div class="sc-head"><i></i>${t("Доступна версия {0}", "0.2.5")}</div>
        <div class="sc-bar"><span></span></div>
        <div class="sc-btn"><span class="u1">${t("Обновить")}</span><span class="u2">${t("Скачиваю…")}</span><span class="u3">${t("Установить и перезапустить")}</span></div>
      </div>
      <div class="sc-done">✓ ${t("Новая версия установлена")}</div>
      <div class="sc-cursor">${CURSOR}<span class="sc-click"></span></div>
    </div>`;
}

/** Компактный режим: окно сворачивается в мини-пульт, выбор режима, запись. */
function compactScene() {
  const modes = Array.from({ length: 7 }, (_, i) => `<i class="m${i}"></i>`).join("");
  return `
    <div class="scene scene-compact" aria-hidden="true">
      <div class="sc-desk"><i class="sc-win w1"></i><i class="sc-win w2"></i></div>
      <div class="sc-big">
        <div class="sc-big-head"><b>Screen Revesane</b><span class="sc-dots">⋯</span></div>
        <div class="sc-big-cards"><i></i><i></i><i></i><i class="r"></i></div>
        <div class="sc-big-list"><i></i><i></i><i></i></div>
      </div>
      <div class="sc-mini">
        <div class="sc-mini-head"><span class="sc-mini-dot"></span><b class="t0">00:00</b><b class="t1">00:01</b><b class="t2">00:02</b><span class="sc-mini-x">⤢ ×</span></div>
        <div class="sc-mini-modes">${modes}<span class="sc-mini-pick"></span></div>
        <div class="sc-mini-main">
          <span class="sc-mini-rec"><i></i></span>
          <div class="sc-mini-side">
            <b class="mn0">${t("Запись экрана")}</b><b class="mn1">${t("Выделить и записать видео")}</b>
            <span class="sc-mini-fmt">MP4 ▾</span>
            <span class="sc-mini-acts"><i class="p"></i><i class="s"></i><i></i></span>
          </div>
        </div>
      </div>
      <div class="sc-cursor">${CURSOR}<span class="sc-click"></span></div>
      <div class="sc-caption">
        <span class="q1">${t("1. «⋯» в заголовке — свернуть в мини-пульт")}</span>
        <span class="q2">${t("2. Режим — одной иконкой")}</span>
        <span class="q3">${t("3. REC — запись, рядом пауза и стоп")}</span>
      </div>
    </div>`;
}

const SCENES = { region: regionScene, self: selfScene, themes: themesScene, update: updateScene, compact: compactScene };

export function sceneHtml(name) {
  return SCENES[name] ? SCENES[name]() : "";
}

/** Заполнить все [data-scene] внутри root (для «Помощи»). */
export function mountScenes(root = document) {
  root.querySelectorAll("[data-scene]").forEach((host) => {
    host.innerHTML = sceneHtml(host.dataset.scene);
  });
}
