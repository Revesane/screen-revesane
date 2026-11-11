"use strict";

import { Recorder, pickMimeType, mimeToExt, grabStill, grabRegion } from "../recorder/recorder.js";

const $ = (id) => document.getElementById(id);

const state = {
  mode: "screen",
  sources: [],
  selected: { screen: null, window: null },
  region: null,          // {x,y,width,height,displayId,displaySize,scaleFactor}
  recording: false,
  busy: false,
  regionPending: false,  // оверлей выделения открыт: ждём рамку (видео)
  shotPending: false,    // оверлей выделения открыт для снимка
  regionBackdrop: null,  // снимок области для первых кадров записи
  prewarmTimer: null,    // отпускаем прогретый захват, если запись не началась
  lastInfo: null,
  lastStart: null,
  recordCommands: [],
  display: null,
  selection: new Set(),
  filter: "all",
  action: "video",
  settings: null,
  info: null,
};

const recorder = new Recorder({
  onChunk: (buffer) => window.api.sendChunk(buffer),
  onError: (err) => {
    setRecState("error");
    $("status").textContent = "Ошибка записи";
    toast(`Запись прервана: ${err.message}`, "error");
    if (state.recording) void endRecording();
  },
});

let timerHandle = null;
let meterHandle = null;
/** Стоп, пришедший пока запись ещё стартовала (гонка авто-остановки с slow-start). */
let pendingStop = false;

// ───────────────────────────────────────────────── обвязка UI

function toast(message, kind = "") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast${kind ? ` is-${kind}` : ""}`;
  el.hidden = false;
  clearTimeout(toast._timer);
  clearTimeout(toast._leave);
  // Ошибку читают дольше; уходит уведомление плавно, а не исчезает рывком.
  toast._timer = setTimeout(() => {
    el.classList.add("is-leaving");
    toast._leave = setTimeout(() => {
      el.hidden = true;
    }, 180);
  }, kind === "error" ? 9000 : 6000);
}

/** Строка в общий лог приложения (файл в %APPDATA%\Screen Revesane\logs). */
function uiLog(level, message, module = "ui") {
  try {
    void window.api.log?.(level, message, module);
  } catch {
    /* лог не должен мешать работе интерфейса */
  }
}

/** Ошибка в человеческом виде: сообщение + код, если main его вернул. */
function describeFailure(result) {
  if (!result) return "неизвестная ошибка";
  const text = result.message || result.error || result.reason || "неизвестная ошибка";
  return result.code ? `${text} [${result.code}]` : text;
}

function formatSize(bytes) {
  if (!bytes) return "0 Б";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} ГБ`;
  if (mb >= 1) return `${mb.toFixed(1)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** Обратный отсчёт до суток: без часов «12:30», с часами «3:07:45». */
function formatDelay(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const p = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${p(minutes)}:${p(seconds)}` : `${p(minutes)}:${p(seconds)}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setRailState(text, mode) {
  $("rail-state-text").textContent = text;
  $("lamp").className = `lamp${mode ? ` is-${mode}` : ""}`;
}

/** Состояние панели записи: ready | live | paused | saving | error | shot. */
function setRecState(name) {
  const panel = $("rec-panel");
  if (panel) panel.dataset.state = name;
}

/**
 * Проценты для полосы уровня.
 *
 * Шкала логарифмическая (−60 дБ … 0 дБ), как у индикаторов звука: линейная
 * (rms × 320) не показывала тихий, но живой сигнал — полоса стояла на 2–5 %.
 */
function meterPercent(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
}

/** Полоса уровня: RMS (0…1) в проценты ширины. */
function paintMeter(meterId, fillId, rms) {
  const meter = $(meterId);
  const fill = $(fillId);
  if (!meter || !fill) return;
  const percent = meterPercent(rms);
  fill.style.width = `${percent}%`;
  meter.classList.toggle("is-idle", percent === 0);
}

/**
 * Живые уровни во время записи: рекордер отдаёт RMS отдельно для микрофона и
 * для системного звука, поэтому полосы показывают свои дорожки, а не догадку.
 */
function startMeters() {
  stopMeters();
  meterHandle = setInterval(() => {
    const settings = state.settings || {};
    const system = settings.systemAudio ? recorder.level("system") : 0;
    const mic = settings.mic ? recorder.level("mic") : 0;
    paintMeter("system-meter", "system-level-fill", system);
    paintMeter("mic-level", "mic-level-fill", mic);
    const db = $("mic-db");
    if (db) db.textContent = mic > 0.0005 ? `${Math.round(20 * Math.log10(mic))} дБ` : "—";
  }, 120);
}

function stopMeters() {
  clearInterval(meterHandle);
  meterHandle = null;
  paintMeter("system-meter", "system-level-fill", 0);
  paintMeter("mic-level", "mic-level-fill", 0);
  const db = $("mic-db");
  if (db) db.textContent = "—";
}

/** Полоски в компактном окне рисуются теми же RMS-значениями. */
function paintMiniMeter(fillId, rms) {
  const fill = $(fillId);
  if (!fill) return;
  fill.style.width = `${meterPercent(rms)}%`;
}

/**
 * Живые уровни без записи.
 *
 * Раньше полосы у карточек «Микрофон» и «Система» оживали только во время
 * записи (или по кнопке «Проверить»), и по ним нельзя было понять, есть ли
 * сигнал до старта. Теперь при включённом переключателе держим отдельные
 * потоки и показываем уровень всё время; перед записью отпускаем устройства.
 */
const previewMeters = {
  mic: { stream: null, ctx: null, analyser: null },
  system: { stream: null, ctx: null, analyser: null, pending: null },
  handle: null,
  generation: 0,
};

/**
 * Полностью отпустить превью перед стартом записи.
 *
 * Сессия захвата экрана в Chromium одна: пока жив поток превью, запись
 * получает его параметры (в самотесте это дало кадр 160×90 вместо 2560×1440).
 * Поэтому гасим превью, ждём закрытия сессии и только потом пишем.
 */
async function releasePreviewMeters() {
  const pending = previewMeters.system.pending;
  stopPreviewMic();
  stopPreviewSystem();
  if (pending) await pending.catch(() => {});
  await sleep(350);
}

function readAnalyserRms(analyser) {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const sample = (data[i] - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / data.length);
}

function startPreviewLoop() {
  if (previewMeters.handle) return;
  previewMeters.handle = setInterval(() => {
    if (state.recording) return; // во время записи полосы ведёт рекордер
    const mic = previewMeters.mic.analyser ? readAnalyserRms(previewMeters.mic.analyser) : 0;
    const system = previewMeters.system.analyser ? readAnalyserRms(previewMeters.system.analyser) : 0;
    paintMeter("mic-level", "mic-level-fill", mic);
    paintMeter("system-meter", "system-level-fill", system);
    paintMiniMeter("mini-mic-fill", mic);
    paintMiniMeter("mini-system-fill", system);
    const db = $("mic-db");
    if (db) db.textContent = mic > 0.0005 ? `${Math.round(20 * Math.log10(mic))} дБ` : "—";
  }, 120);
}

function stopPreviewLoop() {
  if (!previewMeters.handle) return;
  clearInterval(previewMeters.handle);
  previewMeters.handle = null;
}

async function startPreviewMic() {
  stopPreviewMic();
  try {
    const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const deviceId = state.settings?.micDeviceId;
    if (deviceId) constraints.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    // Пока открывался поток, могла начаться запись — тогда он лишний.
    if (state.recording) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const ctx = new AudioContext();
    // Как и в рекордере: без resume контекст остаётся suspended и анализатор
    // читает тишину, хотя звук идёт.
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    previewMeters.mic = { stream, ctx, analyser };
    startPreviewLoop();
  } catch (err) {
    uiLog("warn", `индикация микрофона недоступна: ${err.name || err.message}`, "audio");
  }
}

function stopPreviewMic() {
  const mic = previewMeters.mic;
  previewMeters.mic = { stream: null, ctx: null, analyser: null };
  try {
    mic.stream?.getTracks().forEach((track) => track.stop());
  } catch {
    /* уже остановлены */
  }
  try {
    mic.ctx?.close();
  } catch {
    /* уже закрыт */
  }
  paintMeter("mic-level", "mic-level-fill", 0);
  paintMiniMeter("mini-mic-fill", 0);
  if (!previewMeters.system.analyser) stopPreviewLoop();
}

async function startPreviewSystem() {
  stopPreviewSystem();
  // На macOS loopback нет: без выбранного входа (BlackHole) индикации не будет.
  if (IS_MAC && !systemSourceId()) {
    uiLog("warn", "индикация системного звука на macOS требует BlackHole — выберите его источником звука компьютера", "audio");
    return;
  }
  // Номер попытки: если за время открытия превью его отменили (или началась
  // запись), пришедший позже поток сразу закрываем, а не держим в фоне.
  const generation = previewMeters.generation;
  if (systemSourceId()) {
    await startPreviewSystemDevice(generation);
    return;
  }
  try {
    await window.api.armLoopback({ displayId: null }).catch(() => {});
    const pending = navigator.mediaDevices.getDisplayMedia({
      // Параметры те же, что у записи: сессия захвата экрана в Chromium одна,
      // и если превью попросит 160×90, запись унаследует этот размер.
      video: { frameRate: Math.min(60, Math.max(5, Number(state.settings?.fps) || 30)) },
      audio: true,
    });
    previewMeters.system.pending = pending;
    const stream = await pending.catch((err) => {
      uiLog("warn", `индикация системного звука недоступна: ${err.name || err.message}`, "audio");
      return null;
    });
    previewMeters.system.pending = null;
    if (!stream) return;
    if (generation !== previewMeters.generation || state.recording) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      stream.getTracks().forEach((track) => track.stop());
      uiLog("warn", "системный звук не отдал аудиодорожку", "audio");
      return;
    }
    const ctx = new AudioContext();
    // Как и в рекордере: без resume контекст остаётся suspended и анализатор
    // читает тишину, хотя звук идёт.
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(new MediaStream([audioTrack])).connect(analyser);
    previewMeters.system = { stream, ctx, analyser, pending: null };
    startPreviewLoop();
  } catch (err) {
    previewMeters.system.pending = null;
    uiLog("warn", `индикация системного звука недоступна: ${err.name || err.message}`, "audio");
  }
}

/** Индикация уровня с выбранного входа: обычный getUserMedia, сессию захвата экрана не трогает. */
async function startPreviewSystemDevice(generation) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: systemSourceId() },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (generation !== previewMeters.generation || state.recording) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    previewMeters.system = { stream, ctx, analyser, pending: null };
    startPreviewLoop();
  } catch (err) {
    uiLog("warn", `индикация выбранного источника звука недоступна: ${err.name || err.message}`, "audio");
  }
}

function stopPreviewSystem() {
  // Сессия захвата экрана одна на всё приложение: если превью живо, запись
  // унаследует его размеры (160×90) и частоту кадров. Поэтому превью обязано
  // полностью отпускать поток до старта записи.
  previewMeters.generation += 1;
  const system = previewMeters.system;
  previewMeters.system = { stream: null, ctx: null, analyser: null, pending: null };
  try {
    system.stream?.getTracks().forEach((track) => track.stop());
  } catch {
    /* уже остановлены */
  }
  try {
    system.ctx?.close();
  } catch {
    /* уже закрыт */
  }
  paintMeter("system-meter", "system-level-fill", 0);
  paintMiniMeter("mini-system-fill", 0);
  if (!previewMeters.mic.analyser) stopPreviewLoop();
}

/** Полосы нужны только там, где их видно: главная и компактное окно. */
function previewScreenVisible() {
  const active = document.querySelector(".view.is-active")?.id;
  return active === "view-capture" || active === "view-compact";
}

/** Привести индикацию в соответствие с переключателями и записью. */
function syncPreviewMeters() {
  const settings = state.settings || {};
  if (state.recording || !previewScreenVisible()) {
    stopPreviewMic();
    stopPreviewSystem();
    return;
  }
  if (settings.mic) {
    if (!previewMeters.mic.analyser) void startPreviewMic();
  } else {
    stopPreviewMic();
  }
  if (settings.systemAudio) {
    if (!previewMeters.system.analyser) void startPreviewSystem();
  } else {
    stopPreviewSystem();
  }
}

function setRecordingUi(on) {
  $("btn-primary").classList.toggle("is-live", on);
  $("primary-label").textContent = on ? "СТОП" : state.action === "shot" ? "СНЯТЬ" : "REC";
  $("btn-pause").hidden = !on;
  $("rec-lamp").classList.toggle("is-live", on);
  $("status").textContent = on ? "Идёт запись" : "Готов";
  setRecState(on ? "live" : state.action === "shot" ? "shot" : "ready");
  document.querySelectorAll(".preset").forEach((button) => {
    button.disabled = on;
    button.style.opacity = on ? "0.5" : "1";
  });
  $("mode-select-btn").disabled = on;
  setRailState(on ? "запись" : "готов", on ? "live" : "ok");
  renderMini();
}

/** Приводит панель к выбранному действию: видео или скриншот. */
function renderAction() {
  const isShot = state.action === "shot";
  const labels = {
    "screen:video": "Запись экрана",
    "window:video": "Запись окна",
    "region:video": "Выделить и записать видео",
    "audio:video": "Аудио запись",
    "screen:shot": "Скриншот экрана",
    "window:shot": "Скриншот окна",
    "region:shot": "Скриншот области",
  };
  const key = `${state.mode}:${state.action}`;
  $("mode-select-label").textContent = labels[key] || "Запись экрана";

  document.querySelectorAll(".preset").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.preset === key);
    // «Аудио запись» существует только в режиме видео.
    if (button.dataset.preset === "audio:video") button.hidden = isShot;
  });

  // Скриншот не умеет «только звук».
  if (isShot && state.mode === "audio") {
    state.mode = "screen";
    $("mode-select-label").textContent = "Скриншот экрана";
  }

  $("primary-label").textContent = state.recording ? "СТОП" : isShot ? "СНЯТЬ" : "REC";
  $("btn-primary").classList.toggle("is-shot", isShot);
  if (!state.recording) setRecState(isShot ? "shot" : "ready");
  renderPresetKeys();
  renderSources();
  renderMini();
}

function togglePause() {
  if (!state.recording) return;
  if (recorder.paused) {
    recorder.resume();
    $("status").textContent = "Идёт запись";
    $("rail-state-text").textContent = "запись";
    $("btn-pause").innerHTML = "Пауза <kbd>F8</kbd>";
    setRecState("live");
  } else {
    recorder.pause();
    $("status").textContent = "Пауза";
    $("rail-state-text").textContent = "пауза";
    $("btn-pause").innerHTML = "Продолжить <kbd>F8</kbd>";
    setRecState("paused");
  }
}

// ───────────────────────────────────────────────── источники

function currentTarget() {
  const screenMode = state.mode === "region" || state.mode === "audio";
  if (screenMode) {
    const screens = state.sources.filter((s) => s.kind === "screen");
    if (!screens.length) return null;
    const byRegion =
      state.mode === "region" && state.region?.displayId
        ? screens.find((s) => String(s.displayId) === String(state.region.displayId))
        : null;
    const source = byRegion || screens.find((s) => s.id === state.selected.screen) || screens[0];
    return { sourceId: source.id, kind: "screen", name: source.name, displayId: source.displayId };
  }
  const kind = state.mode;
  const source = state.sources.find((s) => s.kind === kind && s.id === state.selected[kind]);
  if (!source) return null;
  return { sourceId: source.id, kind, name: source.name, displayId: source.displayId };
}

async function refreshSources() {
  try {
    state.sources = await window.api.listSources();
  } catch (err) {
    toast(`Не удалось получить список источников: ${err.message}`, "error");
    return;
  }
  renderSources();
}

function visibleSources() {
  if (state.mode === "window") return state.sources.filter((s) => s.kind === "window");
  return state.sources.filter((s) => s.kind === "screen");
}

function renderSources() {
  const list = visibleSources();
  const selKey = state.mode === "audio" ? "screen" : state.mode;
  const regionMode = state.mode === "region";

  const select = $("sel-source");
  select.innerHTML = "";
  if (!list.length) {
    select.disabled = true;
    const option = document.createElement("option");
    option.textContent = state.mode === "window" ? "окна не найдены" : "экраны не найдены";
    select.appendChild(option);
  } else {
    select.disabled = false;
    for (const source of list) {
      const option = document.createElement("option");
      option.value = source.id;
      option.textContent = source.name || "(без имени)";
      select.appendChild(option);
    }
    if (!state.selected[selKey] || !list.some((s) => s.id === state.selected[selKey])) {
      state.selected[selKey] = list[0].id;
    }
    select.value = state.selected[selKey];
  }

  // Для области источник всегда весь экран: список мониторов скрыт,
  // вместо него — кнопка выделения и размер области.
  select.hidden = regionMode;
  $("btn-pick-region").hidden = !regionMode;
  $("region-label").hidden = !regionMode;

  const modeNames = {
    screen: "Весь экран",
    window: "Окно приложения",
    region: "Выделенная область",
    audio: "Только звук",
  };
  const sourceStatus = $("source-status");
  if (sourceStatus) sourceStatus.textContent = modeNames[state.mode] || "Весь экран";

  // Превью источника — настоящий снимок рабочего стола/окна из списка
  // источников (desktopCapturer отдаёт его вместе с именем), не картинка-заглушка.
  const current = list.find((source) => source.id === select.value) || list[0];
  const previewWrap = $("source-preview-wrap");
  const previewImg = $("source-preview");
  if (previewWrap && previewImg) {
    if (current?.thumbnail) {
      previewImg.src = current.thumbnail;
      previewImg.alt = current.name || "источник";
      previewWrap.hidden = false;
    } else {
      previewImg.removeAttribute("src");
      previewWrap.hidden = true;
    }
  }

  renderRegionCard();
  updateStrip();
}

function renderRegionCard() {
  const label = $("region-label");
  if (!label) return;
  if (state.region) {
    label.textContent = `${Math.round(state.region.width)}×${Math.round(state.region.height)} в (${Math.round(state.region.x)}, ${Math.round(state.region.y)})`;
    label.classList.add("is-set");
  } else {
    label.textContent = "не выбрана";
    label.classList.remove("is-set");
  }
}

/** Нижняя строка-статус панели: авто-стоп, расписание, формат. */
function updateStrip() {
  const settings = state.settings || {};
  const minutes = Number(settings.autostopMin) || 0;
  $("strip-autostop-text").textContent = `Автоматическая остановка (${minutes ? `${minutes} мин` : "OFF"})`;
  $("strip-autostop").classList.toggle("is-on", minutes > 0);
  const armed = Boolean(schedule.startTimer);
  if (armed && schedule.label) {
    $("strip-schedule-text").textContent = `Расписание задач (${schedule.label})`;
  } else {
    const delayMin = Number($("sel-schedelay")?.value) || 0;
    const clock = $("sel-schemode")?.value === "clock";
    $("strip-schedule-text").textContent = `Расписание задач (${
      clock ? clockFieldValue() || "OFF" : delayMin ? `${delayMin} мин` : "OFF"
    })`;
  }
  $("strip-schedule").classList.toggle("is-on", armed || Number($("sel-schedelay")?.value) > 0);
  const container = String(settings.videoContainer || "auto");
  $("strip-format-text").textContent = `Формат: ${container === "auto" ? "как у Chromium" : container.toUpperCase()}`;
  $("strip-format").classList.toggle("is-on", container !== "auto");
  // Своё окно: «скрыто» — приложение исключено из захвата (hideSelf), «в кадре»
  // — попадает в запись.
  const selfHidden = settings.hideSelf !== false;
  $("strip-self-text").textContent = selfHidden ? "Своё окно: скрыто" : "Своё окно: в кадре";
  $("strip-self").classList.toggle("is-on", !selfHidden);
}

// ───────────────────────────────────────────────── горячие клавиши

const HK_NAMES = {
  toggle: "старт/стоп",
  stop: "только стоп",
  pause: "пауза",
  screenshot: "скриншот",
  region: "выделить и записать видео",
  regionShot: "снимок области",
  library: "библиотека",
  mic: "микрофон",
  panel: "панель",
};

/** Подсказка в отсчёте: какие клавиши сейчас назначены. */
function countdownHintText() {
  const keys = (state.settings && state.settings.hotkeys) || {};
  const parts = [];
  if (keys.toggle) parts.push(`${keys.toggle} — старт/стоп`);
  if (keys.pause) parts.push(`${keys.pause} — пауза`);
  if (keys.stop) parts.push(`${keys.stop} — стоп`);
  parts.push("Esc — отмена");
  return parts.join(" · ");
}

function renderHotkeys() {
  const keys = (state.settings && state.settings.hotkeys) || {};
  document.querySelectorAll(".hk").forEach((button) => {
    const name = button.dataset.hk;
    const value = keys[name] || "";
    button.textContent = value || "не задано";
    button.classList.toggle("is-set", Boolean(value));
    button.classList.toggle("is-empty", !value);
    button.classList.remove("is-capturing");
  });
  renderPresetKeys();
}

/** Какое действие с клавишей запускает пункт списка режимов. */
const PRESET_KEYS = {
  "screen:video": "toggle",
  "window:video": "toggle",
  "audio:video": "toggle",
  "region:video": "region",
  "screen:shot": "screenshot",
  "window:shot": "screenshot",
  "region:shot": "regionShot",
};

function prettyKey(accelerator) {
  return accelerator
    .split("+")
    .map((part) => (part === "Control" ? "Ctrl" : part === "Super" ? "Win" : part))
    .join("+");
}

/**
 * Рядом с пунктами списка режимов — назначенные клавиши. «Область» запускается
 * своей клавишей всегда; старт/стоп и скриншот работают в выбранном режиме, поэтому
 * у остальных пунктов метка приглушена (пока пункт не выбран).
 */
function renderPresetKeys() {
  const keys = (state.settings && state.settings.hotkeys) || {};
  const active = `${state.mode}:${state.action}`;
  document.querySelectorAll(".preset").forEach((button) => {
    const preset = button.dataset.preset;
    const accelerator = keys[PRESET_KEYS[preset]] || "";
    let badge = button.querySelector(".preset-key");
    if (!accelerator) {
      badge?.remove();
      button.removeAttribute("title");
      return;
    }
    if (!badge) {
      badge = document.createElement("kbd");
      badge.className = "preset-key";
      button.appendChild(badge);
    }
    badge.textContent = prettyKey(accelerator);
    const direct = preset === "region:video" || preset === "region:shot";
    badge.classList.toggle("is-indirect", !direct && preset !== active);
    const what = preset.endsWith(":shot")
      ? direct ? "снимок области" : "скриншот в выбранном режиме"
      : direct ? "выделить область и сразу записать" : "старт/стоп записи в выбранном режиме";
    button.title = `${prettyKey(accelerator)} — ${what}`;
  });
}

/** Событие клавиатуры → accelerator Electron. */
function acceleratorFromEvent(event) {
  const key = normalizeKey(event);
  if (!key) return null;
  const mods = [];
  if (event.ctrlKey) mods.push("Control");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Super");
  // Одиночный символ перехватил бы ввод во всех программах.
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return null;
  return [...mods, key].join("+");
}

function normalizeKey(event) {
  const raw = event.key;
  if (/^F\d{1,2}$/.test(raw)) return raw;
  if (raw.length === 1) {
    if (/[a-z]/i.test(raw)) return raw.toUpperCase();
    if (/[0-9]/.test(raw)) return raw;
    const symbols = {
      " ": "Space", "-": "-", "=": "=", ",": ",", ".": ".", "/": "/",
      ";": ";", "'": "'", "[": "[", "]": "]", "\\": "\\",
    };
    return symbols[raw] ?? null;
  }
  const named = {
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Enter: "Return", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
  };
  return named[raw] ?? null;
}

/** Клавиша отклонена: подсветить поле красным на секунду. */
function flashRejectedHotkey(name) {
  const button = document.querySelector(`.hk[data-hk="${name}"]`);
  if (!button) return;
  button.classList.add("is-rejected");
  setTimeout(() => button.classList.remove("is-rejected"), 900);
}

function hotkeyRejectReason(check) {
  if (check?.reason === "duplicate") {
    return `уже занято действием «${HK_NAMES[check.owner] || check.owner}» (${check.ownerKey || ""})`;
  }
  if (check?.reason === "busy") return "это сочетание держит другая программа";
  if (check?.reason === "invalid") return check.error || "система не принимает такое сочетание";
  return check?.error || "проверка не прошла";
}

function bindHotkeyEditor() {
  let capturing = null;

  document.querySelectorAll(".hk").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".hk").forEach((item) => item.classList.remove("is-capturing"));
      capturing = button.dataset.hk;
      button.classList.add("is-capturing");
      button.classList.remove("is-empty");
      button.textContent = "нажмите клавиши…";
    });
  });

  document.querySelectorAll("[data-hk-clear]").forEach((button) => {
    button.addEventListener("click", async () => {
      const name = button.dataset.hkClear;
      const hotkeys = { ...(state.settings.hotkeys || {}), [name]: "" };
      await saveSetting({ hotkeys });
      renderHotkeys();
      toast(`Клавиша «${HK_NAMES[name] || name}» очищена`, "ok");
    });
  });

  document.addEventListener(
    "keydown",
    async (event) => {
      if (!capturing) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        capturing = null;
        renderHotkeys();
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) {
        toast("Нужен F-ряд или сочетание с Ctrl / Alt / Shift / Win", "error");
        return;
      }
      const name = capturing;
      capturing = null;
      // Проверяем ДО сохранения: занятое другой программой или другим действием
      // сочетание не должно записываться в настройки.
      let check = { ok: true };
      try {
        check = await window.api.checkHotkey({ name, accelerator });
      } catch (err) {
        check = { ok: false, reason: "failed", error: err.message };
      }
      if (!check?.ok) {
        renderHotkeys();
        flashRejectedHotkey(name);
        uiLog("warn", `клавиша ${accelerator} отклонена: ${hotkeyRejectReason(check)}`, "hotkeys");
        toast(`«${HK_NAMES[name] || name}» не назначено: ${hotkeyRejectReason(check)}`, "error");
        return;
      }
      const hotkeys = { ...(state.settings.hotkeys || {}), [name]: accelerator };
      await saveSetting({ hotkeys });
      renderHotkeys();
      uiLog("info", `клавиша «${HK_NAMES[name] || name}» → ${accelerator}`, "hotkeys");
      toast(`«${HK_NAMES[name] || name}» → ${accelerator}`, "ok");
    },
    true,
  );

  $("btn-key-reset").addEventListener("click", async () => {
    await saveSetting({
      hotkeys: {
        toggle: "F9",
        pause: "F8",
        screenshot: "F10",
        region: "F7",
        regionShot: "F6",
        stop: "",
        library: "",
        mic: "",
        panel: "",
      },
    });
    renderHotkeys();
    toast("Клавиши сброшены: F9 / F8 / F10 / F7 / F6", "ok");
  });
}

/** Глобальная клавиша «выделение области». */
/**
 * F7: выделить область и сразу писать её видео.
 *
 * Раньше клавиша только выделяла прямоугольник — запись запускалась второй
 * клавишей. Снимок области остался на F6, поэтому у этой клавиши одна задача:
 * выделил → пишем. Если рамку отменили, режим возвращается как был.
 */
async function handleRegionHotkey() {
  // Идёт запись — та же клавиша останавливает её: не нужно помнить вторую
  // комбинацию, «выделил и записал» закрывается тем же нажатием.
  if (state.recording) {
    uiLog("info", "горячая клавиша «выделить и записать видео» → стоп", "hotkeys");
    await endRecording();
    return;
  }
  // Оверлей уже открыт — то же нажатие подтверждает нарисованную рамку и
  // запускает запись. Так работает сценарий «выделил → нажал ещё раз → пишем».
  if (state.regionPending) {
    window.api.confirmRegion();
    return;
  }
  if (state.busy) return;
  const before = { mode: state.mode, action: state.action };
  state.mode = "region";
  state.action = "video";
  const picked = await chooseRegion();
  if (!picked) {
    state.mode = before.mode;
    state.action = before.action;
    renderAction();
    return;
  }
  renderAction();
  // Действие становится «видео» и в настройках, иначе после перезапуска
  // клавиша снова оказалась бы в режиме скриншота.
  if (before.action !== "video") void saveSetting({ captureAction: "video" });
  await beginRecording();
}

// ───────────────────────────────────────────────── область

/** Выделение области. true — область выбрана, false — отмена или ошибка. */
async function chooseRegion() {
  state.busy = true;
  state.regionPending = true;
  try {
    const picked = await window.api.pickRegion({ intent: state.action === "shot" ? "shot" : "video" });
    if (!picked?.ok) {
      const reason = picked?.reason || "нет ответа";
      // «busy» и таймаут раньше выглядели одинаково — «Область не выбрана».
      // Теперь по сообщению видно, что именно произошло.
      if (reason === "busy") toast("Выделение области уже открыто", "error");
      else if (reason === "timeout" || reason === "load-failed") {
        toast("Оверлей выделения не открылся — попробуйте ещё раз", "error");
      } else if (reason !== "cancelled") toast("Область не выбрана", "error");
      uiLog(reason === "cancelled" ? "info" : "warn", `выделение области: ${reason}`, "region");
      // Выделение отменили — прогретый захват больше не нужен, отпускаем его.
      clearTimeout(state.prewarmTimer);
      state.prewarmTimer = null;
      recorder.dropPrewarm();
      return false;
    }
    state.region = {
      ...picked.region,
      displayId: picked.displayId,
      displaySize: picked.displaySize,
      scaleFactor: picked.scaleFactor,
    };
    // Заглушка первых кадров: выделенная область, вырезанная из снимка экрана,
    // который оверлей показывал под рамкой.
    state.regionBackdrop = picked.placeholder || null;
    // Формат, выбранный в оверлее, применяем до старта записи: от него зависит
    // контейнер, в который сохранится файл.
    if (picked.container && picked.container !== state.settings?.videoContainer) {
      await saveSetting({ videoContainer: picked.container });
      uiLog("info", `формат записи: ${picked.container}`, "capture");
    }
    const screen = state.sources.find(
      (s) => s.kind === "screen" && String(s.displayId) === String(picked.displayId),
    );
    if (screen) state.selected.screen = screen.id;
    renderSources();
    toast(`Область: ${Math.round(state.region.width)}×${Math.round(state.region.height)}`, "ok");
    return true;
  } finally {
    state.busy = false;
    state.regionPending = false;
  }
}

// ───────────────────────────────────────────────── отсчёт

function runCountdown(seconds) {
  return new Promise((resolve) => {
    const overlay = $("countdown");
    const num = $("countdown-num");
    const hint = $("countdown-hint");
    let left = seconds;
    overlay.hidden = false;
    num.textContent = String(left);
    if (hint) hint.textContent = countdownHintText();
    const handle = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(handle);
        overlay.hidden = true;
        resolve();
        return;
      }
      num.textContent = String(left);
    }, 1000);
  });
}

// ───────────────────────────────────────────────── тест звука и камеры в плитках

const deviceTest = {
  mic: { stream: null, ctx: null, analyser: null, raf: null, timer: null },
  camera: { stream: null },
};

function micMeterReset() {
  const level = $("mic-level");
  if (level) level.classList.add("is-idle");
  const fill = $("mic-level-fill");
  if (fill) fill.style.width = "0%";
  const db = $("mic-db");
  if (db) db.textContent = "—";
  const note = $("mic-note");
  if (note) note.textContent = "голос";
  const button = $("btn-mic-test");
  if (button) {
    button.classList.remove("is-on");
    button.textContent = "Тест";
  }
}

function stopMicTest(message) {
  const state = deviceTest.mic;
  if (state.raf) cancelAnimationFrame(state.raf);
  clearTimeout(state.timer);
  try {
    state.stream?.getTracks().forEach((track) => track.stop());
  } catch {
    /* поток уже закрыт */
  }
  try {
    void state.ctx?.close();
  } catch {
    /* контекст уже закрыт */
  }
  deviceTest.mic = { stream: null, ctx: null, analyser: null, raf: null, timer: null };
  micMeterReset();
  if (message) toast(message, "ok");
}

/** Тест микрофона: уровень в реальном времени, автостоп через 20 с. */
async function startMicTest() {
  if (deviceTest.mic.stream) {
    stopMicTest("Тест микрофона остановлен");
    return false;
  }
  const button = $("btn-mic-test");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = new AudioContext();
    // Как и в рекордере: без resume контекст остаётся suspended и анализатор
    // читает тишину, хотя звук идёт.
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    deviceTest.mic = { stream, ctx, analyser, raf: null, timer: null };

    const level = $("mic-level");
    if (level) level.classList.remove("is-idle");
    const data = new Uint8Array(analyser.fftSize);
    let peak = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const sample = (data[i] - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / data.length);
      peak = Math.max(peak, rms);
      const fill = $("mic-level-fill");
      if (fill) fill.style.width = `${meterPercent(rms)}%`;
      const db = $("mic-db");
      if (db) db.textContent = rms > 0.0005 ? `${Math.round(20 * Math.log10(rms))} дБ` : "тихо";
      deviceTest.mic.raf = requestAnimationFrame(tick);
    };
    tick();
    if (button) {
      button.classList.add("is-on");
      button.textContent = "Стоп";
    }
    const note = $("mic-note");
    if (note) note.textContent = "говорите — полоса должна двигаться";
    // Держать устройство открытым бесконечно нельзя: 20 секунд достаточно, чтобы проверить звук.
    deviceTest.mic.timer = setTimeout(() => {
      const db = peak > 0.0005 ? `${Math.round(20 * Math.log10(peak))} дБ` : "тишина";
      stopMicTest(`Тест микрофона закончен, пик ${db}`);
    }, 20_000);
    uiLog("info", "тест микрофона начат", "audio");
    return true;
  } catch (err) {
    uiLog("warn", `тест микрофона не начался: ${err.message}`, "audio");
    toast(`Микрофон недоступен: ${err.message}`, "error");
    const note = $("mic-note");
    if (note) note.textContent = "микрофон недоступен";
    return false;
  }
}

function stopCameraTest() {
  try {
    deviceTest.camera.stream?.getTracks().forEach((track) => track.stop());
  } catch {
    /* поток уже закрыт */
  }
  deviceTest.camera.stream = null;
  const video = $("camera-preview");
  if (video) {
    try {
      video.pause();
    } catch {
      /* ещё не играло */
    }
    video.srcObject = null;
  }
  const wrap = $("camera-preview-wrap");
  if (wrap) wrap.hidden = true;
  const empty = $("camera-empty");
  if (empty) empty.hidden = false;
  const button = $("btn-camera-test");
  if (button) {
    button.classList.remove("is-on");
    button.textContent = "Проверить";
  }
}

/** Проверка камеры: превью прямо в плитке. */
async function startCameraTest() {
  if (deviceTest.camera.stream) {
    stopCameraTest();
    return false;
  }
  const button = $("btn-camera-test");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 } },
    });
    deviceTest.camera.stream = stream;
    const video = $("camera-preview");
    if (video) {
      video.srcObject = stream;
      await video.play().catch(() => {});
    }
    const wrap = $("camera-preview-wrap");
    if (wrap) wrap.hidden = false;
    const empty = $("camera-empty");
    if (empty) empty.hidden = true;
    if (button) {
      button.classList.add("is-on");
      button.textContent = "Стоп";
    }
    uiLog("info", "тест камеры начат", "camera");
    return true;
  } catch (err) {
    uiLog("warn", `камера недоступна: ${err.message}`, "camera");
    toast(`Камера недоступна: ${err.message}`, "error");
    return false;
  }
}

/** «Сделать фотографию»: отсчёт 3 с, кадр из превью — в папку снимков. */
async function takeCameraPhoto() {
  if (!deviceTest.camera.stream) {
    const started = await startCameraTest();
    if (!started) return null;
    await sleep(700); // камере нужно время на первый кадр
  }
  const video = $("camera-preview");
  if (!video || !video.videoWidth) {
    toast("Кадр с камеры ещё не готов", "error");
    return null;
  }
  const button = $("btn-camera-photo");
  const original = button?.textContent || "Фото";
  if (button) button.disabled = true;
  for (let left = 3; left > 0; left -= 1) {
    if (button) button.textContent = String(left);
    await sleep(1000);
  }
  if (button) {
    button.disabled = false;
    button.textContent = original;
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const result = await window.api.screenshot(canvas.toDataURL("image/png"));
  if (result?.ok) {
    const name = String(result.path || "").split(/[\\/]/).pop();
    uiLog("info", `фото с камеры: ${name} · ${result.size} Б`, "camera");
    toast(`Фото с камеры: ${name} · ${formatSize(result.size)}`, "ok");
    await renderLibrary();
  } else {
    uiLog("error", `фото с камеры не сохранено: ${describeFailure(result)}`, "camera");
    toast(`Фото не сохранено: ${describeFailure(result)}`, "error");
  }
  return result;
}

// ───────────────────────────────────────────────── запись

/** Главная кнопка: делает то, что выбрано — запись или снимок. */
async function handlePrimary() {
  if (state.recording) {
    await endRecording();
    return;
  }
  if (state.action === "shot") {
    if (state.mode === "region") await takeRegionScreenshot();
    else await takeScreenshot();
    return;
  }
  if (state.mode === "region" && !state.region) {
    await chooseRegion();
    if (!state.region) return;
  }
  await beginRecording();
}

async function beginRecording() {
  if (state.busy) return;
  if (state.recording) {
    await endRecording();
    return;
  }

  const target = currentTarget();
  if (!target) {
    toast("Сначала выберите экран или окно", "error");
    return;
  }
  if (state.mode === "region" && !state.region) {
    await chooseRegion();
    if (!state.region) return;
  }
  if (state.settings.systemAudio && target.kind === "window") {
    uiLog("info", "окно: системный звук пойдёт отдельной сессией захвата экрана", "audio");
  }

  state.busy = true;
  pendingStop = false;
  // Тестовые потоки держат те же устройства, что нужны записи: отпускаем их.
  if (deviceTest.mic.stream) stopMicTest();
  if (deviceTest.camera.stream) stopCameraTest();
  // Индикация микрофона/системы тоже держит захват экрана — отпускаем до старта.
  await releasePreviewMeters();
  setRailState("подготовка", "ok");

  try {
    if (state.settings.soundOnStart) playBeep();
    if (state.settings.countdown > 0) await runCountdown(state.settings.countdown);

    const isAudio = state.mode === "audio";
    const mime = pickMimeType();
    const ext = isAudio ? ".webm" : mimeToExt(mime);
    const payloadTarget = { ...target, systemAudio: loopbackWanted() };

    const started = await window.api.startCapture({
      target: payloadTarget,
      ext,
      audio: isAudio,
      // Захват собственного окна требует снять защиту от захвата на время записи.
      selfVisible: /Screen Revesane/i.test(String(target.name || "")),
      // Для области заглушка уже есть (её вырезал оверлей) — лишний вызов
      // desktopCapturer в main только отодвигал старт.
      needPlaceholder: state.mode !== "region",
    });
    if (!started.ok) {
      uiLog("error", `старт записи отклонён: ${describeFailure(started)}`, "capture");
      toast(`Не удалось начать запись: ${describeFailure(started)}`, "error");
      return;
    }
    state.display = started.display;
    // Что main реально взял из настроек — нужно самопроверке авто-стопа.
    state.lastStart = { autostopMin: started.autostopMin ?? null, at: Date.now() };

    const info = isAudio
      ? await recorder.startAudio({
          target: payloadTarget,
          mic: Boolean(state.settings.mic),
          micDevice: state.settings.micDeviceId || "",
          systemAudio: Boolean(state.settings.systemAudio),
          ...mixSettings(),
        })
      : await recorder.start({
          target: payloadTarget,
          crop: state.mode === "region" ? state.region : null,
          display: started.display,
          fps: Number(state.settings.fps),
          quality: state.settings.quality,
          mic: Boolean(state.settings.mic),
          micDevice: state.settings.micDeviceId || "",
          systemAudio: Boolean(state.settings.systemAudio),
          ...mixSettings(),
          webcam: Boolean(state.settings.webcam),
          // Пока WGC не отдал первый кадр, рисуем снимок области: запись
          // стартует сразу, а не через 5 секунд.
          placeholder:
            state.mode === "region" ? state.regionBackdrop || started.placeholder : started.placeholder,
          // Окну системный звук выдаётся второй сессией захвата «экран + звук»:
          // loopback на Windows привязан к экранному источнику, не к окну.
          loopbackArm: async () => {
            await window.api.armLoopback({ displayId: started.display?.id ?? null });
          },
        });

    state.recording = true;
    state.lastInfo = info;
    setRecordingUi(true);
    // Прогретый захват пошёл в дело — сторож больше не нужен.
    clearTimeout(state.prewarmTimer);
    state.prewarmTimer = null;
    // Рамка записываемой области: тонкий контур с анимированным REC и таймером.
    // В кадр она не попадает — окно исключено из захвата в main.
    if (state.mode === "region" && state.region) {
      // Формат показываем в значке рядом с таймером — тоже вне кадра.
      const container = String(state.settings.videoContainer || "auto").toLowerCase();
      const format =
        container === "auto"
          ? mimeToExt(info.mimeType).replace(".", "").toUpperCase()
          : container.toUpperCase();
      void window.api.showFrame({ region: state.region, format });
    }
    if (state.settings.minimizeOnRecord) window.api.minimize();
    timerHandle = setInterval(() => {
      const elapsedMs = recorder.elapsedMs;
      $("timer").textContent = formatClock(elapsedMs);
      const miniTimer = $("mini-timer");
      if (miniTimer) miniTimer.textContent = formatClock(elapsedMs);
      window.api.panelState({ elapsedMs, paused: recorder.paused });
    }, 250);
    startMeters();

    const hint = $("cap-hint");
    hint.classList.toggle("is-warn", info.warnings.length > 0);
    if (info.warnings.length) {
      hint.textContent = info.warnings.join("; ");
      toast(info.warnings.join("; "), "error");
    } else if (isAudio) {
      hint.textContent = `Пишем звук → ${String(state.settings.audioFormat || "mp3").toUpperCase()}${state.settings.mic ? " + микрофон" : ""}.`;
    } else {
      hint.textContent = `Пишем ${info.width}×${info.height}, ${Math.round(info.bitrate / 1000)} кбит/с, ${state.settings.fps} fps.`;
    }

    // Стоп пришёл, пока шёл старт записи: применяем сразу после того, как
    // запись стала активной, иначе команда терялась и запись шла до конца.
    if (pendingStop) {
      pendingStop = false;
      console.log("beginRecording: отложенный стоп применяю после старта");
      void endRecording();
    }
  } catch (err) {
    await window.api.abortCapture().catch(() => {});
    await recorder.cancel().catch(() => {});
    void window.api.hideFrame();
    state.recording = false;
    setRecordingUi(false);
    setRailState("ошибка", "");
    toast(`Запись не началась: ${err.message}`, "error");
  } finally {
    state.busy = false;
  }
}

async function endRecording() {
  if (!state.recording) return null;
  state.recording = false;
  state.busy = true;
  // Рамка области нужна только пока идёт запись.
  void window.api.hideFrame();
  clearInterval(timerHandle);
  timerHandle = null;
  stopMeters();
  $("status").textContent = "Сохраняем…";

  let result = null;
  try {
    const recordedMs = recorder.elapsedMs;
    await recorder.stop();
    // Пока ffmpeg собирает контейнер, панель показывает «Сохраняем…»:
    // на длинной записи перекод занимает секунды.
    $("status").textContent = "Сохраняем…";
    setRecState("saving");
    // Передаём реальную длительность записи: main стартует отсчёт раньше
    // (до разрешения на захват и инициализации холста), и проверка «файл
    // короче сессии» без этого числа давала ложные срабатывания.
    result = await window.api.finishCapture({ recordedMs });
    uiLog(
      result?.ok ? "info" : "error",
      `конец записи: ok=${result?.ok} ${result?.code ?? ""} ${recordedMs} мс ${result?.path ? result.path.split(/[\\/]/).pop() : ""}`,
      "capture",
    );
    setRecordingUi(false);
    $("timer").textContent = "00:00";

    if (!result.ok) {
      setRecState("error");
      $("status").textContent = "Не сохранено";
      uiLog("error", `файл не сохранён: ${describeFailure(result)}`, "capture");
      toast(`Файл не сохранён: ${describeFailure(result)}`, "error");
      return result;
    }
    const name = result.path.split(/[\\/]/).pop();
    // Формат в сообщении — из реального расширения файла, а не жёсткий MP4:
    // при записи «только звук» в WAV тост врал.
    const outExt = (String(result.path || "").split(".").pop() || "").toUpperCase();
    const extra = result.converted ? ` (перекодировано в ${outExt})` : result.note ? ` — ${result.note}` : "";
    const codeHint = result.code ? ` [${result.code}]` : "";
    toast(`Сохранено: ${name} · ${formatSize(result.size)} · ${formatClock(recordedMs)}${extra}${codeHint}`, "ok");
    result.recordedMs = recordedMs;
    renderLibrary();
    void refreshSources();
    $("cap-hint").textContent = `Последняя запись: ${name}`;
    return result;
  } catch (err) {
    // Если остановка упала, захват в main остаётся «активным» и все следующие
    // старты получают «запись уже идёт» [SR1003]. Обязательно освобождаем.
    await window.api.abortCapture().catch(() => {});
    await recorder.cancel().catch(() => {});
    setRecordingUi(false);
    setRecState("error");
    $("status").textContent = "Ошибка";
    uiLog("error", `остановка записи упала: ${err.message}`, "capture");
    toast(`Не удалось сохранить: ${err.message}`, "error");
    return null;
  } finally {
    state.busy = false;
    if (state.settings.minimizeOnRecord) window.api.restore();
    // Запись закончилась — возвращаем живую индикацию сигнала на карточки.
    syncPreviewMeters();
    renderMini();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function playBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    setTimeout(() => ctx.close().catch(() => {}), 700);
  } catch {
    /* сигнал не критичен */
  }
}

// ───────────────────────────────────────────────── скриншот

async function takeScreenshot() {
  if (state.recording || state.busy) return;
  const target = currentTarget();
  if (!target) {
    toast("Сначала выберите экран или окно", "error");
    return;
  }
  state.busy = true;
  setRailState("снимок", "ok");
  const restoreProtection = Boolean(state.settings.hideSelf);
  try {
    // Своё окно видно в снимке только со снятой защитой от захвата.
    await window.api.selfProtect(false).catch(() => {});
    await window.api.arm({ ...target, systemAudio: false });
    const format = state.settings.screenshotFormat === "jpg" ? "image/jpeg" : "image/png";
    const dataUrl = await grabStill(target, format);
    const result = await window.api.screenshot({ dataUrl, format: state.settings.screenshotFormat });
    if (result?.ok) toast(`Скриншот сохранён · ${formatSize(result.size)}`, "ok");
    renderLibrary();
  } catch (err) {
    toast(`Скриншот не получился: ${err.message}`, "error");
  } finally {
    await window.api.arm(null).catch(() => {});
    await window.api.selfProtect(restoreProtection).catch(() => {});
    state.busy = false;
    setRailState("готов", "ok");
  }
}

/** Как «Ножницы»: выделил область → снимок открылся картинкой, можно копировать. */
async function takeRegionScreenshot() {
  if (state.recording || state.busy) {
    uiLog("warn", "снимок области пропущен: занято", "shot");
    return;
  }
  state.busy = true;
  setRailState("снимок", "ok");
  // Рамку снимка можно подтвердить повторным нажатием его же клавиши.
  state.shotPending = true;
  const restoreProtection = Boolean(state.settings.hideSelf);
  try {
    const picked = await window.api.pickRegion({ intent: "shot" });
    if (!picked?.ok) {
      uiLog("info", `снимок области отменён: ${picked?.reason || "без причины"}`, "shot");
      return;
    }
    const screens = state.sources.filter((s) => s.kind === "screen");
    const source =
      screens.find((s) => String(s.displayId) === String(picked.displayId)) || screens[0];
    if (!source) throw new Error("нет экрана для снимка");

    await window.api.selfProtect(false).catch(() => {});
    await window.api.arm({ sourceId: source.id, kind: "screen", displayId: source.displayId, systemAudio: false });
    const dataUrl = await grabRegion({
      x: picked.region.x,
      y: picked.region.y,
      width: picked.region.width,
      height: picked.region.height,
      displaySize: picked.displaySize,
    });
    // Каждый исход пишем в лог: раньше снимок области молчал, и по логу нельзя
    // было понять, дошло ли дело до редактора.
    const size = `${Math.round(picked.region.width)}×${Math.round(picked.region.height)}`;
    if (picked.copy) {
      // Ctrl+C в оверлее: снять и положить в буфер, без редактора.
      // Буфер пишется только из сфокусированного документа, а после оверлея
      // фокус остаётся у чужого окна — поэтому сначала поднимаем своё.
      await window.api.focusWindow().catch(() => {});
      await sleep(160);
      const copied = await copyDataUrlToClipboard(dataUrl);
      uiLog("info", `снимок области ${size} → буфер обмена (${copied?.ok ? "ок" : "не удалось"})`, "shot");
      if (copied?.ok) toast("Снимок области скопирован в буфер обмена", "ok");
      else toast(`Снимок снят, но в буфер не попал: ${copied?.error || "нет доступа к буферу"}`, "error");
      return;
    }
    uiLog("info", `снимок области: ${size} → редактор`, "shot");
    // Редактор живёт в главном окне, а после оверлея фокус у браузера: без
    // этого окно с редактором открывалось бы «за» чужим и его не было видно.
    await window.api.focusWindow().catch(() => {});
    openEditorWithImage({ dataUrl, name: `region-${Date.now()}` });
    toast("Снимок области открыт — можно разметить, скопировать или сохранить", "ok");
  } catch (err) {
    uiLog("error", `снимок области не получился: ${err.message}`, "shot");
    toast(`Снимок области не получился: ${err.message}`, "error");
  } finally {
    await window.api.arm(null).catch(() => {});
    await window.api.selfProtect(restoreProtection).catch(() => {});
    state.busy = false;
    state.shotPending = false;
    setRailState("готов", "ok");
  }
}

// ───────────────────────────────────────────────── библиотека

function renderRecent(all) {
  const list = $("recent-list");
  if (!list) return;
  list.innerHTML = "";
  const rows = (all || []).slice(0, 5);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Пока ничего не записано — первая запись появится здесь.";
    list.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "recent-item";

    const thumb = document.createElement("span");
    thumb.className = `thumb is-${row.kind}`;
    thumb.innerHTML = KIND_ICONS[row.kind] ?? KIND_ICONS.video;

    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = row.name;
    name.title = row.name;

    const meta = document.createElement("span");
    meta.className = "recent-meta";
    meta.textContent = `${formatSize(row.size)} · ${formatDate(row.mtime)}`;

    const play = document.createElement("button");
    play.className = "icon-action";
    play.title = row.kind === "audio" ? "Проиграть во внешнем плеере" : "Открыть";
    play.innerHTML = ICON.play;
    play.addEventListener("click", () => {
      if (row.kind === "audio") void window.api.open(row.path);
      else void openEditor(row);
    });

    const more = document.createElement("button");
    more.className = "icon-action is-more";
    more.title = "Ещё";
    more.innerHTML = ICON.more;
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openFileMenu(more, row);
    });

    item.append(thumb, name, meta, play, more);
    list.appendChild(item);
  }
}

/** Иконки типов файлов: миниатюр у нас нет, поэтому тип читается по значку. */
const KIND_ICONS = {
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5l4.5 2.5-4.5 2.5z"/></svg>',
  shot: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3.5 3.5 2.5-2.5L19 17"/></svg>',
  audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
};

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5l8 5.5-8 5.5z"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.5V20h3.5L19 8.5 15.5 5z"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-7 7"/><path d="M18 14.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.2l1.8 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7"/></svg>',
};

let fileMenu = null;

/** Меню действий над файлом: те же операции, что в библиотеке. */
function openFileMenu(anchor, row) {
  closeFileMenu();
  const actions = [
    row.kind === "audio"
      ? { label: "Открыть в плеере", icon: ICON.open, run: () => window.api.open(row.path) }
      : { label: "Открыть в редакторе", icon: ICON.edit, run: () => openEditor(row) },
    { label: "Показать в папке", icon: ICON.folder, run: () => window.api.reveal(row.path) },
    { label: "Открыть файл", icon: ICON.open, run: () => window.api.open(row.path) },
    { sep: true },
    { label: "Удалить в корзину", icon: ICON.trash, danger: true, run: () => deleteFile(row) },
  ];

  const menu = document.createElement("div");
  menu.className = "menu";
  for (const action of actions) {
    if (action.sep) {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      menu.appendChild(sep);
      continue;
    }
    const button = document.createElement("button");
    button.className = `menu-item${action.danger ? " is-danger" : ""}`;
    button.innerHTML = action.icon;
    button.append(action.label);
    button.addEventListener("click", async () => {
      closeFileMenu();
      await action.run();
    });
    menu.appendChild(button);
  }

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(window.innerWidth - width - 10, Math.max(10, rect.right - width));
  const top = rect.bottom + 6 + height > window.innerHeight - 10
    ? Math.max(10, rect.top - height - 6)
    : rect.bottom + 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  fileMenu = menu;
  setTimeout(() => {
    document.addEventListener("click", closeFileMenu, { once: true });
    document.addEventListener("keydown", onFileMenuKey, { once: true });
  }, 0);
}

function onFileMenuKey(event) {
  if (event.key === "Escape") closeFileMenu();
}

function closeFileMenu() {
  if (!fileMenu) return;
  fileMenu.remove();
  fileMenu = null;
}

/** Удаление в корзину — как кнопкой в библиотеке. */
async function deleteFile(row) {
  const result = await window.api.deleteMedia({ filePath: row.path });
  if (result?.ok) {
    toast(`В корзине: ${row.name}`, "ok");
    await renderLibrary();
  } else {
    toast(`Не удалось удалить: ${result?.error || result?.reason}`, "error");
  }
}

async function renderLibrary() {
  const list = $("library-list");
  const all = await window.api.library();
  renderRecent(all);
  const rows = state.filter === "all" ? all : all.filter((row) => row.kind === state.filter);
  list.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = all.length
      ? state.filter === "shot" ? "Снимков пока нет." : state.filter === "audio" ? "Аудиозаписей пока нет." : "Видеозаписей пока нет."
      : "Пока пусто. Записи и скриншоты появятся здесь.";
    list.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "row-check";
    // Выбираемое: видео — для «Склеить», снимки PNG/JPG/BMP — для «Панорамы».
    // Аудио и TIFF/GIF не годятся ни для того, ни для другого.
    const selectable =
      row.kind === "video" || (row.kind === "shot" && /\.(png|jpe?g|bmp)$/i.test(row.path));
    if (!selectable) {
      check.disabled = true;
      check.style.opacity = "0.25";
    } else {
      check.checked = state.selection.has(row.path);
      if (check.checked) item.classList.add("is-selected");
      check.addEventListener("change", () => {
        if (check.checked) state.selection.add(row.path);
        else state.selection.delete(row.path);
        item.classList.toggle("is-selected", check.checked);
        paintSelectionBar();
      });
    }

    const kind = document.createElement("div");
    kind.className = "row-kind";
    kind.innerHTML =
      row.kind === "shot"
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3.5 3.5 2.5-2.5L19 17"/></svg>'
        : row.kind === "audio"
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10.5 9.5l4.5 2.5-4.5 2.5z"/></svg>';

    const name = document.createElement("div");
    name.className = "row-name";
    name.textContent = row.name;
    name.style.cursor = "pointer";
    name.title = row.kind === "audio" ? "Открыть во внешнем плеере" : "Открыть в редакторе";
    name.addEventListener("click", () => {
      if (row.kind === "audio") void window.api.open(row.path);
      else void openEditor(row);
    });

    const meta = document.createElement("div");
    meta.className = "row-meta";
    meta.textContent = `${formatSize(row.size)} · ${formatDate(row.mtime)}`;

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const open = document.createElement("button");
    open.className = "ghost";
    open.textContent = "Открыть";
    open.addEventListener("click", () => window.api.open(row.path));

    const reveal = document.createElement("button");
    reveal.className = "ghost";
    reveal.textContent = "В папке";
    reveal.addEventListener("click", () => window.api.reveal(row.path));

    actions.append(open, reveal);
    if (row.kind === "video") {
      const cut = document.createElement("button");
      cut.className = "ghost";
      cut.textContent = "Подрезать";
      cut.addEventListener("click", () => openEditor(row));
      actions.append(cut);
    }
    item.append(check, kind, name, meta, actions);
    list.appendChild(item);
  }

  paintSelectionBar();
}

function paintSelectionBar() {
  const bar = $("list-bar");
  const count = state.selection.size;
  bar.hidden = count === 0;
  $("list-bar-text").textContent = `выбрано: ${count}`;
  // «Склеить» считает только видео: снимки в склейку не идут.
  const videos = [...state.selection].filter((item) => /\.(mp4|webm|mkv|mov|wmv|f4v|ts)$/i.test(item)).length;
  $("btn-merge").disabled = videos < 2;
  $("btn-merge").style.opacity = videos < 2 ? "0.45" : "1";
  const shots = [...state.selection].filter((item) => /\.(png|jpe?g|bmp)$/i.test(item)).length;
  $("btn-panorama").disabled = shots < 2;
  $("btn-panorama").style.opacity = shots < 2 ? "0.45" : "1";
}

// ───────────────────────────────────────────────── расписание

const schedule = { startTimer: null, stopTimer: null, tickTimer: null, at: 0, label: "" };

function scheduleMode() {
  return $("sel-schemode")?.value === "clock" ? "clock" : "delay";
}

function clockFieldValue() {
  return String($("inp-scheclock")?.value || "").trim();
}

/**
 * Момент старта для режима «в точное время»: ближайшие сутки, когда этот час
 * ещё не прошёл. Чистая функция — её проверяет самопроверка.
 */
function resolveClockAt(clockText, now = new Date()) {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(String(clockText || "").trim());
  if (!matched) return null;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return null;
  const at = new Date(now.getTime());
  at.setHours(hours, minutes, 0, 0);
  let tomorrow = false;
  if (at.getTime() <= now.getTime() + 999) {
    at.setDate(at.getDate() + 1);
    tomorrow = true;
  }
  return { at, tomorrow };
}

function formatAtLabel(at, tomorrow) {
  const p = (n) => String(n).padStart(2, "0");
  return `${tomorrow ? "завтра" : "сегодня"}, ${p(at.getHours())}:${p(at.getMinutes())}`;
}

/** Что произойдёт, если нажать «Запустить по расписанию» с текущими полями. */
function describeScheduleTarget() {
  if (scheduleMode() === "clock") {
    const resolved = resolveClockAt(clockFieldValue());
    if (!resolved) return { ok: false, text: "—" };
    return { ok: true, at: resolved.at.getTime(), label: formatAtLabel(resolved.at, resolved.tomorrow) };
  }
  const delayMin = Number($("sel-schedelay")?.value) || 0;
  if (delayMin <= 0) return { ok: false, text: "не задано" };
  const delayMs = delayMin * 60_000;
  return { ok: true, at: Date.now() + delayMs, label: `через ${formatDelay(delayMs)}` };
}

/** Показывает нужное поле и пересчитывает строку «Старт». */
function refreshScheduleTarget() {
  const clock = scheduleMode() === "clock";
  const fieldDelay = $("field-schedelay");
  const fieldClock = $("field-scheclock");
  if (fieldDelay) fieldDelay.hidden = clock;
  if (fieldClock) fieldClock.hidden = !clock;
  const atEl = $("schedule-at");
  if (atEl && !schedule.startTimer) {
    const target = describeScheduleTarget();
    atEl.textContent = target.ok ? target.label : target.text;
  }
  updateStrip();
}

function cancelSchedule(silent) {
  clearTimeout(schedule.startTimer);
  clearTimeout(schedule.stopTimer);
  clearInterval(schedule.tickTimer);
  schedule.startTimer = null;
  schedule.stopTimer = null;
  schedule.tickTimer = null;
  schedule.at = 0;
  schedule.label = "";
  const stateEl = $("schedule-state");
  if (stateEl) stateEl.textContent = "не запланировано";
  if (!state.recording) $("status").textContent = "Готов к записи";
  refreshScheduleTarget();
  if (!silent) toast("Расписание отменено", "ok");
}

/**
 * Планирование записи.
 * armSchedule({ mode:"clock", clock:"21:30", durationMin:5 })
 * armSchedule({ delayMin: 0.05, durationMin: 0 })  // проверка в самопроверке
 */
function armSchedule(options) {
  cancelSchedule(true);
  const opts = typeof options === "number" ? { delayMin: options } : { ...(options || {}) };
  const durationMin = Number(opts.durationMin ?? 0) || 0;
  let at = 0;
  let label = "";
  if (opts.mode === "clock" || (!opts.mode && opts.clock)) {
    const resolved = resolveClockAt(opts.clock ?? clockFieldValue());
    if (!resolved) {
      toast("Укажите время старта в формате ЧЧ:ММ", "error");
      return false;
    }
    at = resolved.at.getTime();
    label = formatAtLabel(resolved.at, resolved.tomorrow);
  } else {
    const delayMin = Number(opts.delayMin ?? 0) || 0;
    if (delayMin <= 0) {
      toast("Выберите, через сколько минут начать", "error");
      return false;
    }
    at = Date.now() + delayMin * 60_000;
    label = `через ${formatDelay(delayMin * 60_000)}`;
  }

  const delayMs = Math.max(1000, at - Date.now());
  schedule.at = at;
  schedule.label = label;

  const paint = () => {
    const left = Math.max(0, schedule.at - Date.now());
    if ($("schedule-state")) $("schedule-state").textContent = `старт через ${formatDelay(left)}`;
    if ($("schedule-at")) $("schedule-at").textContent = label;
    if (!state.recording) $("status").textContent = `по расписанию через ${formatDelay(left)}`;
    updateStrip();
  };
  paint();
  schedule.tickTimer = setInterval(paint, 500);

  schedule.startTimer = setTimeout(async () => {
    schedule.startTimer = null;
    clearInterval(schedule.tickTimer);
    schedule.tickTimer = null;
    if ($("schedule-state")) $("schedule-state").textContent = "запись по расписанию";
    await beginRecording();
    if (Number(durationMin) > 0) {
      schedule.stopTimer = setTimeout(() => {
        schedule.stopTimer = null;
        void endRecording();
      }, Number(durationMin) * 60_000);
    }
  }, delayMs);

  toast(
    `Запись начнётся ${label}${durationMin > 0 ? `, длительность ${durationMin} мин` : ""}`,
    "ok",
  );
  return true;
}

// ───────────────────────────────────────────────── панорама из снимков

async function loadImageFromLibrary(filePath) {
  const response = await window.api.readImage({ filePath });
  if (!response?.ok) throw new Error(response?.error || response?.reason || "файл не прочитался");
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("формат не читается Chromium"));
    image.src = response.dataUrl;
  });
  return image;
}

function scaledHeight(image, width) {
  return Math.max(1, Math.round((image.naturalHeight * width) / image.naturalWidth));
}

/** Ищет, на сколько пикселей нижний снимок перекрывает верхний. */
function verticalOverlap(topImage, bottomImage, width) {
  const probeRows = 40;
  const topHeight = scaledHeight(topImage, width);
  const bottomHeight = scaledHeight(bottomImage, width);
  const rows = Math.min(bottomHeight, probeRows);

  const topCanvas = document.createElement("canvas");
  topCanvas.width = width;
  topCanvas.height = topHeight;
  topCanvas.getContext("2d").drawImage(topImage, 0, 0, width, topHeight);

  const bottomCanvas = document.createElement("canvas");
  bottomCanvas.width = width;
  bottomCanvas.height = rows;
  bottomCanvas.getContext("2d").drawImage(bottomImage, 0, 0, width, bottomHeight);
  const bottomData = bottomCanvas.getContext("2d").getImageData(0, 0, width, rows).data;
  const topData = topCanvas.getContext("2d").getImageData(0, 0, width, topHeight).data;

  const scoreAt = (offset) => {
    if (offset < 0 || offset + rows > topHeight) return Number.POSITIVE_INFINITY;
    let sum = 0;
    let count = 0;
    for (let y = 0; y < rows; y += 2) {
      for (let x = 0; x < width; x += 4) {
        const topIndex = ((offset + y) * width + x) * 4;
        const bottomIndex = (y * width + x) * 4;
        sum +=
          Math.abs(topData[topIndex] - bottomData[bottomIndex]) +
          Math.abs(topData[topIndex + 1] - bottomData[bottomIndex + 1]) +
          Math.abs(topData[topIndex + 2] - bottomData[bottomIndex + 2]);
        count += 3;
      }
    }
    return count ? sum / count : Number.POSITIVE_INFINITY;
  };

  const searchStart = Math.max(0, topHeight - 4000);
  let best = { offset: searchStart, score: Number.POSITIVE_INFINITY };
  for (let offset = searchStart; offset < topHeight - 8; offset += 6) {
    const score = scoreAt(offset);
    if (score < best.score) best = { offset, score };
  }
  for (let offset = best.offset - 6; offset <= best.offset + 6; offset += 1) {
    const score = scoreAt(offset);
    if (score < best.score) best = { offset, score };
  }

  const overlap = topHeight - best.offset;
  return best.score < 14 && overlap > 20 ? overlap : 0;
}

async function buildPanorama(paths) {
  const images = [];
  for (const filePath of paths) images.push(await loadImageFromLibrary(filePath));
  if (!images.length) throw new Error("нет снимков");

  const width = Math.min(...images.map((image) => image.naturalWidth));
  const heights = images.map((image) => scaledHeight(image, width));
  const overlaps = [];
  for (let index = 1; index < images.length; index += 1) {
    overlaps.push(verticalOverlap(images[index - 1], images[index], width));
  }

  const positions = [0];
  for (let index = 1; index < images.length; index += 1) {
    positions.push(positions[index - 1] + heights[index - 1] - overlaps[index - 1]);
  }
  const totalHeight = positions[positions.length - 1] + heights[heights.length - 1];

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = totalHeight;
  const ctx = canvas.getContext("2d");
  images.forEach((image, index) => ctx.drawImage(image, 0, positions[index], width, heights[index]));

  return { dataUrl: canvas.toDataURL("image/png"), width, height: totalHeight, overlaps };
}

// ───────────────────────────────────────────────── прогресс предпросмотра

/**
 * Прокси-предпросмотр длинного MKV собирается ffmpeg секунды-минуты.
 * Пока идёт сборка, в кадре редактора висит полоса с процентом и остатком:
 * иначе окно выглядит зависшим.
 */
const previewProgress = { active: false, startedAt: 0, durationSec: 0, percent: 0, timer: null };
/** Последние события прогресса — их читает самопроверка, чтобы доказать, что процент идёт. */
const previewEvents = [];

function previewProgressPaint(note) {
  const bar = $("preview-progress");
  if (!bar || !previewProgress.active) return;
  const fill = $("preview-progress-fill");
  const noteEl = $("preview-progress-note");
  const determinate = previewProgress.percent > 0;
  bar.classList.toggle("is-indeterminate", !determinate);
  if (fill) fill.style.width = `${determinate ? previewProgress.percent : 0}%`;
  if (noteEl) noteEl.textContent = note ?? "";
}

function showPreviewProgress(text) {
  const bar = $("preview-progress");
  if (!bar) return;
  previewProgress.active = true;
  previewProgress.startedAt = Date.now();
  previewProgress.durationSec = 0;
  previewProgress.percent = 0;
  bar.hidden = false;
  bar.classList.add("is-indeterminate");
  const textEl = $("preview-progress-text");
  if (textEl) textEl.textContent = text || "Готовим предпросмотр…";
  previewProgressPaint("сборка прокси для проигрывания");
  clearInterval(previewProgress.timer);
  previewProgress.timer = setInterval(() => {
    if (!previewProgress.active || previewProgress.percent > 0) return;
    const elapsed = Date.now() - previewProgress.startedAt;
    previewProgressPaint(`идёт ${formatDelay(elapsed)} · для длинной записи это нормально`);
  }, 500);
}

function hidePreviewProgress() {
  previewProgress.active = false;
  clearInterval(previewProgress.timer);
  previewProgress.timer = null;
  const bar = $("preview-progress");
  if (bar) {
    bar.hidden = true;
    bar.classList.remove("is-indeterminate");
  }
}

/** События из main: probe → encode (с процентом) → done / error. */
function handlePreviewProgress(payload) {
  if (!payload) return;
  previewEvents.push({ phase: payload.phase, percent: Number(payload.percent) || 0 });
  if (previewEvents.length > 60) previewEvents.shift();
  if (!previewProgress.active) return;
  if (payload.phase === "probe") {
    const textEl = $("preview-progress-text");
    if (textEl) textEl.textContent = "Читаю длительность записи…";
    previewProgressPaint("ffprobe");
    return;
  }
  if (payload.phase === "encode") {
    const textEl = $("preview-progress-text");
    if (textEl) textEl.textContent = "Перекодирую в H.264 для проигрывания…";
    if (Number(payload.durationSec) > 0) previewProgress.durationSec = Number(payload.durationSec);
    if (Number(payload.percent) > 0) previewProgress.percent = Math.min(100, Math.round(payload.percent));
    let note = "";
    if (previewProgress.percent > 0 && previewProgress.durationSec > 0) {
      const elapsed = Date.now() - previewProgress.startedAt;
      const eta = elapsed * ((100 - previewProgress.percent) / previewProgress.percent);
      note =
        `${previewProgress.percent}% · обработано ${formatDelay(previewProgress.durationSec * 1000 * (previewProgress.percent / 100))}` +
        ` из ${formatDelay(previewProgress.durationSec * 1000)} · осталось ~${formatDelay(eta)}`;
    }
    previewProgressPaint(note);
    return;
  }
  if (payload.phase === "error") {
    const textEl = $("preview-progress-text");
    if (textEl) textEl.textContent = `Предпросмотр не собрался: ${payload.error || "ошибка ffmpeg"}`;
    previewProgressPaint("");
    return;
  }
  if (payload.phase === "done") {
    previewProgress.percent = 100;
    previewProgressPaint(payload.cached ? "готовый прокси уже был в кэше" : "готово");
  }
}

// ───────────────────────────────────────────────── редактор

const editor = {
  row: null,
  duration: 0,
  inSec: 0,
  outSec: 0,
  dragging: null,
  busy: false,
};

/** Открывает в редакторе картинку, которой ещё нет на диске (снимок области). */
function openEditorWithImage({ dataUrl, name }) {
  const pseudo = {
    kind: "shot",
    name: name || `region-${Date.now()}`,
    path: null,
    dataUrl,
    size: Math.round((dataUrl.length * 3) / 4),
    mtime: Date.now(),
  };
  void openEditor(pseudo);
}

async function openEditor(row) {
  editor.row = row;
  editor.dragging = null;
  editor.busy = false;
  editor.duration = 0;
  editor.inSec = 0;
  editor.outSec = 0;

  $("editor").hidden = false;
  $("editor-title").textContent = row.name;
  $("editor-meta").textContent = `${formatSize(row.size)} · ${formatDate(row.mtime)}`;
  document.querySelector(".editor-card")?.classList.toggle("is-shot", row.kind === "shot");

  const video = $("editor-video");
  const image = $("editor-image");
  const isShot = row.kind === "shot";

  $("editor-timeline").style.display = isShot ? "none" : "block";
  for (const id of ["editor-play", "editor-mark-in", "editor-mark-out", "editor-trim", "editor-snapshot"]) {
    $(id).disabled = isShot;
    $(id).style.opacity = isShot ? "0.45" : "1";
  }

  if (isShot) {
    video.pause();
    video.removeAttribute("src");
    video.hidden = true;
    image.hidden = true;
    image.removeAttribute("src");
    $("editor-timeline").style.display = "none";
    $("markup-bar").hidden = false;
    $("editor-time").textContent = "—";
    const formatLabel = row.path ? row.name.split(".").pop().toUpperCase() : "PNG";
    $("editor-sel").textContent = `${formatLabel} · разметка`;
    await loadShotIntoCanvas(row);
    return;
  }

  $("markup-bar").hidden = true;
  $("editor-canvas").hidden = true;
  image.hidden = true;
  image.removeAttribute("src");
  video.hidden = false;

  // Chromium не играет H.264 в MKV — для таких файлов main соберёт прокси.
  const needsProxy = !/\.(mp4|webm|mov)$/i.test(row.name);
  if (needsProxy) showPreviewProgress("Готовим предпросмотр…");
  let preview = null;
  try {
    preview = await window.api.previewVideo({ filePath: row.path });
  } catch (err) {
    preview = { ok: false, error: err.message };
  } finally {
    hidePreviewProgress();
  }
  // Редактор могли закрыть или открыть на другом файле, пока строился прокси.
  if (editor.row !== row) return;
  if (!preview?.ok) {
    toast(`Предпросмотр недоступен: ${describeFailure(preview)}`, "error");
    return;
  }
  if (preview.note) {
    $("editor-meta").textContent = `${formatSize(row.size)} · ${formatDate(row.mtime)} · ${preview.note}`;
  }

  video.src = preview.url;
  video.load();
  video.onloadedmetadata = () => {
    editor.duration = Number.isFinite(video.duration) ? video.duration : 0;
    editor.inSec = 0;
    editor.outSec = editor.duration;
    editorPaint();
  };
  editorPaint();
}

/** Подпись кнопки следует за состоянием: «Играть» ↔ «Пауза». */
function paintPlayButton() {
  const button = $("editor-play");
  const video = $("editor-video");
  if (!button || !video) return;
  const playing = !video.paused && !video.ended;
  button.textContent = playing ? "Пауза" : "Играть";
}

/** Воспроизведение/пауза — общая точка для кнопки и пробела. */
function toggleEditorPlay() {
  if (!editor.row || editor.row.kind === "shot") return;
  const video = $("editor-video");
  if (!video) return;
  if (video.paused) void video.play();
  else video.pause();
  editorPaint();
  paintPlayButton();
}

function closeEditor() {
  hidePreviewProgress();
  if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
  const video = $("editor-video");
  try {
    video.pause();
  } catch {
    /* ничего */
  }
  video.removeAttribute("src");
  $("editor-image").removeAttribute("src");
  $("markup-bar").hidden = true;
  $("editor-canvas").hidden = true;
  markup.canvas = null;
  markup.ctx = null;
  markup.base = null;
  markup.undo = [];
  markup.drag = null;
  $("editor").hidden = true;
  editor.row = null;
}

/**
 * Полноэкранный просмотр: во весь экран уходит вся карточка редактора, а не
 * только видео — иначе пропали бы таймлайн и кнопки. Esc и повторный двойной
 * клик возвращают обратно.
 */
async function toggleEditorFullscreen() {
  const card = document.querySelector(".editor-card");
  if (!card) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await card.requestFullscreen();
  } catch (err) {
    toast(`Полный экран недоступен: ${err.message}`, "error");
  }
}

/** Подпись кнопки следует за состоянием: «Во весь экран» ↔ «Свернуть». */
function paintEditorFullscreen() {
  const label = $("editor-fullscreen-label");
  const button = $("editor-fullscreen");
  const on = Boolean(document.fullscreenElement);
  if (label) label.textContent = on ? "Свернуть" : "Во весь экран";
  if (button) button.classList.toggle("is-on", on);
}

function editorPaint() {
  if (!editor.row) return;
  const video = $("editor-video");
  const duration = editor.duration || 1;
  const current = video.currentTime || 0;

  const inPct = (editor.inSec / duration) * 100;
  const outPct = (editor.outSec / duration) * 100;
  $("tl-selection").style.left = `${inPct}%`;
  $("tl-selection").style.right = `${100 - outPct}%`;
  $("tl-in").style.left = `${inPct}%`;
  $("tl-out").style.left = `${outPct}%`;
  $("tl-playhead").style.left = `${Math.min(100, (current / duration) * 100)}%`;

  $("editor-time").textContent = `${formatClock(current * 1000)} / ${formatClock(editor.duration * 1000)}`;
  $("editor-sel").textContent = `вырез ${formatClock(Math.max(0, (editor.outSec - editor.inSec) * 1000))}`;
  $("editor-play").textContent = video.paused ? "Играть" : "Пауза";
}

/**
 * Перетаскивание бегунка: seek на каждый пиксель дёргает декодер, поэтому
 * копим последнюю точку и применяем её раз в кадр.
 */
let scrubRaf = 0;
let scrubPending = null;

function scheduleScrub(seconds) {
  scrubPending = seconds;
  if (scrubRaf) return;
  scrubRaf = requestAnimationFrame(() => {
    scrubRaf = 0;
    if (scrubPending == null) return;
    editorSeek(scrubPending);
    scrubPending = null;
  });
}

/**
 * Какая ручка под курсором: «in», «out» или ничего.
 * Берётся ближайшая, если попадание в пределах 10 px — по тонкой полоске
 * мышью не попасть, а клик по треку должен продолжать работать как переход.
 */
function editorHandleAt(clientX) {
  const timeline = $("editor-timeline");
  if (!timeline || !editor.duration) return null;
  const rect = timeline.getBoundingClientRect();
  const x = clientX - rect.left;
  const inX = (editor.inSec / editor.duration) * rect.width;
  const outX = (editor.outSec / editor.duration) * rect.width;
  const nearIn = Math.abs(x - inX);
  const nearOut = Math.abs(x - outX);
  const grab = 10;
  if (nearIn > grab && nearOut > grab) return null;
  return nearIn <= nearOut ? "in" : "out";
}

function editorSeek(sec) {
  const video = $("editor-video");
  if (!editor.row || editor.row.kind === "shot") return;
  video.currentTime = Math.max(0, Math.min(editor.duration, sec));
  editorPaint();
}

// ───────────────────────────────────────────────── разметка скриншотов

const markup = {
  canvas: null,
  ctx: null,
  base: null,
  undo: [],
  tool: "arrow",
  color: "#ff5a52",
  width: 6,
  drag: null,
};

async function loadShotIntoCanvas(row) {
  const canvas = $("editor-canvas");
  let dataUrl = row.dataUrl;
  if (!dataUrl) {
    const response = await window.api.readImage({ filePath: row.path });
    if (!response?.ok) {
      toast(`Не удалось открыть изображение: ${response?.error || response?.reason}`, "error");
      return;
    }
    dataUrl = response.dataUrl;
  }

  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("формат не читается Chromium"));
      image.src = dataUrl;
    });
  } catch (err) {
    toast(`Картинка не открылась: ${err.message}. Для TIFF/BMP используйте «Открыть».`, "error");
    return;
  }

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);

  markup.canvas = canvas;
  markup.ctx = ctx;
  markup.undo = [];
  markup.drag = null;
  snapshotBase();
  canvas.hidden = false;
}

function snapshotBase() {
  if (!markup.ctx) return;
  markup.base = markup.ctx.getImageData(0, 0, markup.canvas.width, markup.canvas.height);
}

function pushUndo() {
  if (!markup.ctx) return;
  markup.undo.push(markup.ctx.getImageData(0, 0, markup.canvas.width, markup.canvas.height));
  if (markup.undo.length > 12) markup.undo.shift();
}

function restoreBase() {
  if (markup.base) markup.ctx.putImageData(markup.base, 0, 0);
}

function canvasPoint(event) {
  const rect = markup.canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (markup.canvas.width / rect.width),
    y: (event.clientY - rect.top) * (markup.canvas.height / rect.height),
  };
}

function mosaic(from, to) {
  const ctx = markup.ctx;
  const x = Math.round(Math.min(from.x, to.x));
  const y = Math.round(Math.min(from.y, to.y));
  const w = Math.round(Math.abs(to.x - from.x));
  const h = Math.round(Math.abs(to.y - from.y));
  if (w < 4 || h < 4) return;
  const block = Math.max(6, Math.round(Math.min(w, h) / 18));
  const tw = Math.max(1, Math.round(w / block));
  const th = Math.max(1, Math.round(h / block));
  const temp = document.createElement("canvas");
  temp.width = tw;
  temp.height = th;
  temp.getContext("2d").drawImage(markup.canvas, x, y, w, h, 0, 0, tw, th);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(temp, 0, 0, tw, th, x, y, w, h);
  ctx.restore();
}

function drawShape(from, to) {
  const ctx = markup.ctx;
  const lineWidth = Math.max(1, markup.width * (markup.canvas.width / 1600));
  ctx.save();
  ctx.strokeStyle = markup.color;
  ctx.fillStyle = markup.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (markup.tool === "rect") {
    ctx.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y);
  } else if (markup.tool === "arrow") {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = Math.max(12, lineWidth * 5);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else if (markup.tool === "blur") {
    mosaic(from, to);
  }
  ctx.restore();
}

function startTextInput(event) {
  const point = canvasPoint(event);
  const input = document.createElement("input");
  input.className = "markup-text-input";
  input.style.left = `${event.clientX}px`;
  input.style.top = `${event.clientY}px`;
  input.placeholder = "текст, Enter — вставить";
  document.body.appendChild(input);
  input.focus();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    input.remove();
    if (!text || !markup.ctx) return;
    pushUndo();
    const ctx = markup.ctx;
    const size = Math.max(18, markup.width * (markup.canvas.width / 400));
    ctx.save();
    ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.lineWidth = Math.max(2, size / 8);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeText(text, point.x, point.y);
    ctx.fillStyle = markup.color;
    ctx.fillText(text, point.x, point.y);
    ctx.restore();
    snapshotBase();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      done = true;
      input.remove();
    }
  });
  input.addEventListener("blur", commit);
}

/** Копирует холст в буфер обмена: сначала современный API, затем запасной путь. */
/**
 * PNG из data URL в буфер обмена — тем же путём, что и копирование из
 * редактора (chromium-овский navigator.clipboard, с фолбэками).
 */
async function copyDataUrlToClipboard(dataUrl) {
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("картинка не прочиталась"));
      image.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    return await copyCanvasToClipboard(canvas);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function copyCanvasToClipboard(canvas) {
  const errors = [];
  try {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob && navigator.clipboard && typeof window.ClipboardItem === "function") {
      await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
      return { ok: true, via: "navigator.clipboard" };
    }
    errors.push("navigator.clipboard недоступен");
  } catch (err) {
    errors.push(`clipboard: ${err.message || err}`);
  }

  // Фолбэк: копирование картинки через выделение и execCommand("copy").
  try {
    const img = document.createElement("img");
    img.src = canvas.toDataURL("image/png");
    img.style.cssText = "position:fixed;left:-10000px;top:0";
    document.body.appendChild(img);
    const range = document.createRange();
    range.selectNode(img);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = document.execCommand("copy");
    selection.removeAllRanges();
    img.remove();
    if (ok) return { ok: true, via: "execCommand" };
    errors.push("execCommand copy отклонён");
  } catch (err) {
    errors.push(`execCommand: ${err.message || err}`);
  }

  return { ok: false, error: errors.join("; ") };
}

function bindMarkup() {
  document.querySelectorAll(".tool").forEach((button) => {
    button.addEventListener("click", () => {
      markup.tool = button.dataset.tool;
      document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("is-active", b === button));
    });
  });

  document.querySelectorAll(".swatch").forEach((button) => {
    button.addEventListener("click", () => {
      markup.color = button.dataset.color;
      document.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("is-active", b === button));
    });
  });

  $("markup-width").addEventListener("change", (event) => {
    markup.width = Number(event.target.value) || 6;
  });

  $("markup-undo").addEventListener("click", () => {
    if (!markup.undo.length || !markup.ctx) return;
    const previous = markup.undo.pop();
    markup.ctx.putImageData(previous, 0, 0);
    markup.base = previous;
  });

  $("markup-clipboard").addEventListener("click", async () => {
    if (!markup.ctx) return;
    // Буфер обмена пишется только из сфокусированного окна — после оверлея
    // фокус может быть не у нас.
    await window.api.focusWindow().catch(() => {});
    await sleep(120);
    const result = await copyCanvasToClipboard(markup.canvas);
    if (result?.ok) {
      closeEditor();
      void renderLibrary();
      toast("Изображение скопировано в буфер обмена", "ok");
    } else {
      toast(`Не удалось скопировать: ${result?.error || result?.reason}`, "error");
    }
  });

  $("markup-copy").addEventListener("click", async () => {
    if (!markup.ctx || !editor.row) return;
    const format = state.settings.screenshotFormat === "jpg" ? "jpeg" : "png";
    const dataUrl = markup.canvas.toDataURL(format === "jpeg" ? "image/jpeg" : "image/png", 0.92);
    const result = await window.api.saveAnnotated({ dataUrl, format, baseName: editor.row.name });
    if (result?.ok) {
      const name = result.path.split(/[\\/]/).pop();
      closeEditor();
      await renderLibrary();
      toast(`Сохранено: ${name} · ${formatSize(result.size)}`, "ok");
    } else {
      uiLog("error", `разметка не сохранена: ${describeFailure(result)}`, "editor");
      toast(`Не удалось сохранить: ${describeFailure(result)}`, "error");
    }
  });

  $("markup-cancel").addEventListener("click", () => closeEditor());

  const canvas = $("editor-canvas");

  canvas.addEventListener("pointerdown", (event) => {
    if (!markup.ctx || !editor.row) return;
    if (markup.tool === "text") {
      startTextInput(event);
      return;
    }
    pushUndo();
    const point = canvasPoint(event);
    markup.drag = { from: point, to: point };
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!markup.drag) return;
    markup.drag.to = canvasPoint(event);
    restoreBase();
    drawShape(markup.drag.from, markup.drag.to);
  });

  const finishStroke = () => {
    if (!markup.drag) return;
    const { from, to } = markup.drag;
    markup.drag = null;
    restoreBase();
    drawShape(from, to);
    snapshotBase();
  };

  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
  canvas.addEventListener("pointerleave", finishStroke);
}

function bindEditor() {
  const video = $("editor-video");
  const timeline = $("editor-timeline");

  $("editor-close").addEventListener("click", closeEditor);
  $("editor-cancel").addEventListener("click", closeEditor);
  $("editor").addEventListener("click", (event) => {
    if (event.target === $("editor")) closeEditor();
  });
  // Esc сначала выходит из полного экрана и только потом закрывает редактор.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || $("editor").hidden) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
      return;
    }
    closeEditor();
  });

  $("editor-fullscreen").addEventListener("click", () => void toggleEditorFullscreen());
  $("editor-stage").addEventListener("dblclick", () => {
    // В разметке двойной клик — это два штриха по картинке, там полный экран
    // включается только кнопкой.
    if (!$("markup-bar").hidden) return;
    void toggleEditorFullscreen();
  });
  document.addEventListener("fullscreenchange", paintEditorFullscreen);
  paintEditorFullscreen();

  $("editor-play").addEventListener("click", () => toggleEditorPlay());

  video.addEventListener("timeupdate", editorPaint);
  video.addEventListener("ended", editorPaint);
  video.addEventListener("seeked", editorPaint);
  video.addEventListener("play", paintPlayButton);
  video.addEventListener("pause", paintPlayButton);
  video.addEventListener("ended", paintPlayButton);

  $("editor-mark-in").addEventListener("click", () => {
    editor.inSec = Math.min(video.currentTime, editor.outSec - 0.2);
    if (editor.inSec < 0) editor.inSec = 0;
    editorPaint();
  });
  $("editor-mark-out").addEventListener("click", () => {
    editor.outSec = Math.max(video.currentTime, editor.inSec + 0.2);
    if (editor.outSec > editor.duration) editor.outSec = editor.duration;
    editorPaint();
  });

  timeline.addEventListener("pointerdown", (event) => {
    if (!editor.row || editor.row.kind === "shot") return;
    const rect = timeline.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    // Ручка ловится не только точно по полоске: у неё есть запас 10 px в обе
    // стороны, иначе тонкую линию мышью почти невозможно взять.
    const byId = event.target.id === "tl-in" ? "in" : event.target.id === "tl-out" ? "out" : null;
    const handle = byId || editorHandleAt(event.clientX);
    timeline.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    if (handle) {
      editor.dragging = handle;
      timeline.classList.add("is-dragging");
      (handle === "in" ? $("tl-in") : $("tl-out"))?.classList.add("is-dragging");
      return;
    }
    // Всё остальное — бегунок: один клик ставит его в точку, а удержание
    // и ведение плавно тянет за мышью, как в плеере.
    if (!video.paused) video.pause();
    editor.dragging = "seek";
    timeline.classList.add("is-scrubbing");
    editorSeek(fraction * editor.duration);
  });

  window.addEventListener("pointermove", (event) => {
    if (!editor.dragging || !editor.duration) return;
    const rect = timeline.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const seconds = fraction * editor.duration;
    if (editor.dragging === "seek") {
      scheduleScrub(seconds);
      return;
    }
    if (editor.dragging === "in") editor.inSec = Math.min(seconds, editor.outSec - 0.2);
    else editor.outSec = Math.max(seconds, editor.inSec + 0.2);
    editor.inSec = Math.max(0, editor.inSec);
    editor.outSec = Math.min(editor.duration, editor.outSec);
    editorPaint();
  });

  window.addEventListener("pointerup", () => {
    if (!editor.dragging) return;
    const wasSeek = editor.dragging === "seek";
    editor.dragging = null;
    timeline.classList.remove("is-dragging", "is-scrubbing");
    $("tl-in").classList.remove("is-dragging");
    $("tl-out").classList.remove("is-dragging");
    // Последняя точка — точно, без «дребезга» кадров.
    if (wasSeek && scrubPending != null) {
      editorSeek(scrubPending);
      scrubPending = null;
    }
  });

  $("editor-speed-apply").addEventListener("click", async () => {
    if (!editor.row || editor.busy || editor.row.kind !== "video") return;
    const speed = Number($("editor-speed").value);
    if (speed === 1) {
      toast("Скорость 1× — менять нечего", "error");
      return;
    }
    const button = $("editor-speed-apply");
    editor.busy = true;
    button.textContent = "Меняю…";
    try {
      const result = await window.api.speedMedia({ filePath: editor.row.path, speed });
      if (result?.ok) {
        const name = result.path.split(/[\\/]/).pop();
        toast(`Скорость ${speed}×: ${name} · ${formatSize(result.size)}`, "ok");
        closeEditor();
        await renderLibrary();
      } else {
        toast(`Не удалось изменить скорость: ${result?.error || result?.reason}`, "error");
      }
    } finally {
      editor.busy = false;
      button.textContent = "Применить скорость";
    }
  });

  $("editor-snapshot").addEventListener("click", async () => {
    if (!editor.row || editor.busy) return;
    editor.busy = true;
    try {
      const result = await window.api.videoSnapshot({
        filePath: editor.row.path,
        atSec: Number($("editor-video").currentTime) || 0,
      });
      if (result?.ok) toast(`Кадр сохранён · ${formatSize(result.size)}`, "ok");
      else toast(`Кадр не сохранён: ${result?.error || result?.reason}`, "error");
      await renderLibrary();
    } finally {
      editor.busy = false;
    }
  });

  $("editor-delete").addEventListener("click", async () => {
    if (!editor.row || editor.busy) return;
    editor.busy = true;
    try {
      const result = await window.api.deleteMedia({ filePath: editor.row.path });
      if (result?.ok) {
        toast("Файл перемещён в корзину", "ok");
        closeEditor();
        await renderLibrary();
      } else {
        toast(`Не удалось удалить: ${result?.error}`, "error");
      }
    } finally {
      editor.busy = false;
    }
  });

  $("editor-trim").addEventListener("click", async () => {
    if (!editor.row || editor.busy) return;
    const label = $("editor-trim-label");
    editor.busy = true;
    label.textContent = "Режу…";
    try {
      const result = await window.api.trimMedia({
        filePath: editor.row.path,
        startSec: editor.inSec,
        endSec: editor.outSec,
        accurate: $("editor-accurate").checked,
      });
      if (result?.ok) {
        const name = result.path.split(/[\\/]/).pop();
        toast(`Фрагмент сохранён: ${name} · ${formatSize(result.size)} · ${formatClock(result.durationSec * 1000)}`, "ok");
        closeEditor();
        await renderLibrary();
      } else {
        toast(`Не удалось подрезать: ${result?.error || result?.reason}`, "error");
      }
    } finally {
      editor.busy = false;
      label.textContent = "Подрезать";
    }
  });
}

// ───────────────────────────────────────────────── виды и настройки

/** Очистка библиотеки: одна кнопка на главной, в истории и в компактном окне. */
async function clearLibraryUi() {
  const confirmed = window.confirm(
    "Удалить все записи, снимки и звук из папки библиотеки?\nДействие необратимо.",
  );
  if (!confirmed) return;
  const result = await window.api.clearLibrary();
  if (result?.ok) {
    uiLog("info", `библиотека очищена: ${result.removed} файлов`, "library");
    toast(`Очищено: ${result.removed} файлов · ${formatSize(result.freed)}`, "ok");
    state.selection.clear();
    await renderLibrary();
    renderRecent(true);
  } else {
    toast("Очистить библиотеку не удалось", "error");
  }
}

// ───────────────────────────────────────────────── компактный режим окна

let compactMode = false;
let viewBeforeCompact = "view-capture";

/** Свернуть окно в «карманное» и обратно. Размер задаёт main (COMPACT_BOUNDS). */
async function setCompactMode(on) {
  const next = Boolean(on);
  if (next === compactMode) return;
  compactMode = next;
  document.body.classList.toggle("compact", next);
  if (next) viewBeforeCompact = document.querySelector(".view.is-active")?.id || "view-capture";
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("is-active"));
  const target = next ? $("view-compact") : $(viewBeforeCompact) || $("view-capture");
  target?.classList.add("is-active");
  // В компактном окне полосы видны, поэтому индикация переезжает вместе с видом.
  syncPreviewMeters();
  await window.api.setCompact(next).catch(() => {});
  renderMini();
}

/** Компактное окно показывает только главное и живёт на общем состоянии. */
function renderMini() {
  const settings = state.settings || {};
  const recording = Boolean(state.recording);
  const dot = $("mini-dot");
  if (dot) {
    dot.classList.toggle("live", recording && !recorder.paused);
    dot.classList.toggle("paused", recording && recorder.paused);
  }
  const meta = $("mini-meta");
  if (meta) {
    meta.textContent = recording
      ? recorder.paused
        ? "пауза"
        : "запись"
      : state.busy
        ? "подготовка"
        : "готов";
  }
  const primary = $("mini-primary");
  if (primary) primary.classList.toggle("live", recording);
  const label = $("mini-primary-label");
  if (label) label.textContent = recording ? "Стоп" : state.action === "shot" ? "Снимок" : "Записать";
  const mode = $("mini-mode");
  if (mode) {
    mode.textContent =
      {
        "screen:video": "Весь экран",
        "window:video": "Окно",
        "region:video": "Область",
        "audio:video": "Только звук",
        "screen:shot": "Снимок экрана",
        "window:shot": "Снимок окна",
        "region:shot": "Снимок области",
      }[`${state.mode}:${state.action}`] || "Экран";
  }
  const micButton = $("mini-mic");
  if (micButton) micButton.classList.toggle("on", Boolean(settings.mic));
  const systemButton = $("mini-system");
  if (systemButton) systemButton.classList.toggle("on", Boolean(settings.systemAudio));
  const format = $("mini-format");
  if (format) {
    const container = String(settings.videoContainer || "auto").toLowerCase();
    format.textContent = container === "auto" ? "AUTO" : container.toUpperCase();
  }
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  });
  // Подсветка пункта меню: раньше она оставалась на «Главной» при любом переходе.
  document.querySelectorAll(".rail-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === name);
  });
  closeFileMenu();
  if (name === "library") void renderLibrary();
  if (name === "capture") void refreshSources();
  if (name === "settings") updateStrip();
  if (name === "help") renderHelp();
  // Индикация сигнала нужна только на главной (и в компактном окне).
  syncPreviewMeters();
}

/** Ползунки баланса в «Настройки → Звук»: [ползунок, подпись значения, ключ настройки]. */
const MIX_RANGES = [
  ["rng-micvol", "out-micvol", "micVolume"],
  ["rng-sysvol", "out-sysvol", "systemVolume"],
];

/** Заливка дорожки ползунка до бегунка (CSS-переменная --fill). */
function paintRange(range) {
  const span = Number(range.max) - Number(range.min) || 1;
  range.style.setProperty("--fill", `${((Number(range.value) - Number(range.min)) / span) * 100}%`);
}

/** Баланс микрофона и системного звука из настроек — в параметры рекордера. */
function mixSettings() {
  const s = state.settings || {};
  return {
    micVolume: Number(s.micVolume ?? 100),
    systemVolume: Number(s.systemVolume ?? 100),
    micCleanup: s.micCleanup !== false,
    systemDevice: s.systemSourceId || "",
  };
}

/** Выбранный вход со звуком компьютера; пусто — loopback Windows. */
function systemSourceId() {
  return state.settings?.systemSourceId || "";
}

/** Loopback системного звука умеет только Windows: macOS нужен BlackHole. */
const IS_MAC = /Mac/i.test(navigator.userAgent || "");

/** Нужен ли loopback Windows: системный звук включён и отдельный вход не выбран. */
function loopbackWanted() {
  return Boolean(state.settings?.systemAudio) && !systemSourceId() && !IS_MAC;
}

const SWITCHES = {
  "sw-miccleanup": "micCleanup",
  "sw-mic": "mic",
  "sw-system": "systemAudio",
  "sw-webcam": "webcam",
  "sw-sound": "soundOnStart",
  "sw-hideSelf": "hideSelf",
  "sw-minimize": "minimizeOnRecord",
  "sw-panel": "showPanel",
  "sw-cursor": "cursorHighlight",
  "sw-watermark": "watermarkOn",
  "sw-wm-shadow": "watermarkShadow",
};

function buildCodecSelect(select, allowed, labels, current) {
  const options = [["auto", "как у контейнера"]].concat(allowed.map((key) => [key, labels[key] ?? key]));
  select.innerHTML = options
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  select.value = options.some(([value]) => value === current) ? current : "auto";
}

function refreshCodecOptions() {
  const info = state.info;
  if (!info?.codecMatrix) return;
  const raw = state.settings.videoContainer || "auto";
  const key = raw === "mpegts" ? "ts" : raw;
  const matrix = info.codecMatrix[key] ?? info.codecMatrix.mp4;
  buildCodecSelect($("sel-videocodec"), matrix.video, info.codecLabels.video, state.settings.videoCodec || "auto");
  buildCodecSelect($("sel-audiocodec"), matrix.audio, info.codecLabels.audio, state.settings.audioCodec || "auto");
}

/** Ставит значение селекта, только если такая опция есть: настройки правит и человек. */
function setSelectValue(el, value) {
  if (!el) return;
  const next = String(value);
  if (Array.from(el.options).some((option) => option.value === next)) el.value = next;
}

/**
 * Схематичное превью водяного знака в рамке 16:9: то же положение, размер и
 * прозрачность, что будут в файле. Ширина рамки считается за 960 px кадра,
 * поэтому знак в превью выглядит крупнее, чем в записи 1920 px — иначе на
 * 360 px рамки текст был бы неразличим (об этом же говорит подпись под ней).
 */
function renderWatermarkPreview() {
  const box = $("wm-preview");
  const label = $("wm-preview-text");
  if (!box || !label) return;
  const s = state.settings || {};
  const width = box.clientWidth || 360;
  const scale = Math.max(0.3, Math.min(1.6, width / 960));
  const size = Number(s.watermarkSize) || 28;
  const opacity = Math.min(1, Math.max(0.05, Number(s.watermarkOpacity ?? 0.85)));
  const margin = Math.max(0, Number(s.watermarkMargin ?? 24));
  const position = s.watermarkPosition || "bottom-right";
  const fontPx = Math.max(8, Math.min(48, Math.round(size * scale)));
  const marginPx = Math.max(2, Math.round(margin * scale));

  label.textContent = s.watermarkImage ? "PNG" : String(s.watermarkText || "").trim() || "водяной знак";
  label.style.fontSize = `${fontPx}px`;
  label.style.color = `rgba(255, 255, 255, ${opacity.toFixed(2)})`;
  label.style.textShadow = s.watermarkShadow === false ? "none" : "1px 1px 2px rgba(0, 0, 0, 0.6)";

  // В стилях знак прижат к правому нижнему углу — противоположные стороны надо
  // гасить, иначе элемент растянется между left и right.
  const side = { left: "auto", right: "auto", top: "auto", bottom: "auto", transform: "none" };
  if (position === "center") {
    side.left = "50%";
    side.top = "50%";
    side.transform = "translate(-50%, -50%)";
  } else {
    if (position.endsWith("left")) side.left = `${marginPx}px`;
    else side.right = `${marginPx}px`;
    if (position.startsWith("top")) side.top = `${marginPx}px`;
    else side.bottom = `${marginPx}px`;
  }
  Object.assign(label.style, side);
  box.classList.toggle("is-off", !s.watermarkOn);
}

/**
 * Списки аудиоустройств в настройках.
 *
 * Вход (интерфейс/микрофон) реально применяется к записи микрофона. Выход
 * показываем честно: loopback-дорожка Chromium снимает звук с устройства
 * вывода по умолчанию, поэтому выбор — справочный, а переключить нужно в
 * звуковых устройствах Windows.
 */
async function renderAudioDevices() {
  const micSelect = $("sel-micdevice");
  const outSelect = $("sel-outdevice");
  const sysSelect = $("sel-sysource");
  if (!micSelect || !outSelect) return;

  const list = async () => {
    try {
      return await navigator.mediaDevices.enumerateDevices();
    } catch {
      return [];
    }
  };

  let devices = await list();
  // Без разрешения на микрофон названия устройств пустые: просим доступ один
  // раз, чтобы список был читаемым.
  if (!devices.some((device) => device.kind === "audioinput" && device.label)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      devices = await list();
    } catch {
      /* нет доступа — останутся пункты без названий */
    }
  }

  const fill = (select, kind, current, autoLabel) => {
    select.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = autoLabel;
    select.appendChild(auto);
    devices
      .filter((device) => device.kind === kind)
      .forEach((device, index) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        const name = device.label || `${kind === "audioinput" ? "Вход" : "Выход"} ${index + 1}`;
        option.textContent = device.deviceId === "default" ? `${name} (по умолчанию)` : name;
        select.appendChild(option);
      });
    select.value = [...select.options].some((option) => option.value === current) ? current : "";
  };

  fill(micSelect, "audioinput", state.settings?.micDeviceId || "", "Системный по умолчанию");
  fill(outSelect, "audiooutput", state.settings?.outDeviceId || "", "Системное устройство по умолчанию");
  // Источник звука компьютера на главной: Windows или один из входов (интерфейс, кабель).
  if (sysSelect) {
    fill(sysSelect, "audioinput", systemSourceId(), "Звук Windows");
    sysSelect.title = `Источник звука компьютера: ${sysSelect.selectedOptions[0]?.textContent || "Звук Windows"}`;
  }
}

function applySettingsToUi() {
  const s = state.settings;
  $("sel-fps").value = String(s.fps);
  $("sel-quality").value = s.quality;
  $("sel-countdown").value = String(s.countdown);
  $("sel-container").value = s.videoContainer || "auto";
  $("sel-shotformat").value = s.screenshotFormat || "png";
  $("sel-audioformat").value = s.audioFormat || "wav";
  $("sel-audioquality").value = String(s.audioQuality ?? 192);
  // Список устройств заполняется асинхронно: enumerateDevices без разрешения
  // на микрофон отдаёт пустые метки, поэтому внутри есть запрос разрешения.
  void renderAudioDevices();
  $("sel-keyframe").value = String(s.keyframeSec ?? 1);
  $("sel-samplerate").value = String(s.sampleRate ?? 0);
  $("sel-channels").value = String(s.channels ?? 0);
  for (const [rangeId, outId, key] of MIX_RANGES) {
    const value = Number(s[key] ?? 100);
    $(rangeId).value = String(value);
    $(outId).textContent = `${value}%`;
    paintRange($(rangeId));
  }
  refreshCodecOptions();
  $("sel-autostop").value = String(s.autostopMin ?? 0);
  $("sel-panelStyle").value = s.panelStyle || "full";
  // Водяной знак: поля раздела и схематичное превью.
  const wmText = $("inp-wm-text");
  if (wmText && wmText.value !== (s.watermarkText || "")) wmText.value = s.watermarkText || "";
  setSelectValue($("sel-wm-position"), s.watermarkPosition || "bottom-right");
  setSelectValue($("sel-wm-size"), s.watermarkSize ?? 28);
  setSelectValue($("sel-wm-opacity"), s.watermarkOpacity ?? 0.85);
  setSelectValue($("sel-wm-margin"), s.watermarkMargin ?? 24);
  const wmImage = String(s.watermarkImage || "");
  const wmImageLabel = $("wm-image-label");
  if (wmImageLabel) {
    wmImageLabel.textContent = wmImage ? wmImage.split(/[\\/]/).pop() : "не выбрана";
    wmImageLabel.title = wmImage;
  }
  renderWatermarkPreview();
  for (const [id, key] of Object.entries(SWITCHES)) {
    const el = $(id);
    if (el) el.classList.toggle("is-on", Boolean(s[key]));
  }
  $("dir-video").textContent = state.info?.outputDir || "—";
  $("dir-shots").textContent = state.info?.outputDirShots || state.info?.outputDir || "—";
  $("audio-mic").textContent = s.mic ? "вкл" : "выкл";
  $("audio-system").textContent = s.systemAudio ? "вкл" : "выкл";
  const keys = s.hotkeys || {};
  $("key-toggle") && ($("key-toggle").value = keys.toggle || "");
  renderHotkeys();
  updateStrip();
}

async function saveSetting(patch) {
  const next = await window.api.setSettings(patch);
  const hotkeyErrors = next?.hotkeyErrors;
  if (next) delete next.hotkeyErrors;
  state.settings = next;
  if (Array.isArray(hotkeyErrors) && hotkeyErrors.length) {
    toast(`Горячие клавиши не назначены: ${hotkeyErrors.join("; ")}`, "error");
  }
  applySettingsToUi();
}

async function renderInfo() {
  const info = state.info;
  $("brand-ver").textContent = `v${info.version}`;
  $("settings-note").textContent = info.outputDir;
  $("codec-note").textContent = info.ffmpeg
    ? "Chromium пишет MP4 (H.264 + AAC) напрямую. «Как пишет Chromium» оставляет файл как есть; любой другой контейнер собирается ffmpeg при остановке записи."
    : "ffmpeg не найден: запись идёт в том виде, который даёт Chromium (MP4 или WebM), перекод в другие контейнеры недоступен.";
  $("about-version").textContent = `${info.name} ${info.version}`;
  $("about-runtime").textContent = `${info.electron} / ${info.chrome} / ${info.node}`;
  $("about-ffmpeg").textContent = info.ffmpeg
    ? info.ffmpegSource === "auto" ? "скачан автоматически" : "найден в PATH"
    : "не найден";
  $("about-settings").textContent = info.settingsPath || "—";
  if ($("about-build")) {
    const stamp = info.buildTime ? new Date(info.buildTime) : null;
    $("about-build").textContent = stamp
      ? `${stamp.toLocaleDateString("ru-RU")} ${stamp.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
      : "—";
  }
  if ($("about-path")) $("about-path").textContent = info.appPath || "—";
  if ($("about-log")) $("about-log").textContent = info.logPath || "—";
  if ($("about-crashdumps")) $("about-crashdumps").textContent = info.crashDumps || "—";
}

/** Действия с горячими клавишами — в том же порядке, что в настройках. */
const HELP_ACTIONS = [
  ["toggle", "Начать / остановить запись", "Запись"],
  ["stop", "Только остановить", "Запись"],
  ["pause", "Пауза / продолжить", "Запись"],
  ["screenshot", "Скриншот", "Запись"],
  ["region", "Выделить и записать видео", "Запись"],
  ["regionShot", "Снимок области (сразу редактор)", "Запись"],
  ["library", "Открыть библиотеку", "Интерфейс"],
  ["mic", "Микрофон вкл / выкл", "Интерфейс"],
  ["panel", "Плавающая панель вкл / выкл", "Интерфейс"],
];

/**
 * Раздел «Помощь»: назначения клавиш и пути берутся из текущего состояния,
 * а не из статичного текста — иначе справка быстро начинает врать.
 */
function renderHelp() {
  const box = $("help-hotkeys");
  const info = state.info;
  if ($("help-dir-video")) $("help-dir-video").textContent = info?.outputDir || "—";
  if ($("help-dir-shots")) $("help-dir-shots").textContent = info?.outputDirShots || info?.outputDir || "—";
  if ($("help-log")) $("help-log").textContent = info?.logPath || "—";
  if (!box) return;

  const keys = state.settings?.hotkeys || {};
  box.innerHTML = "";
  for (const group of ["Запись", "Интерфейс"]) {
    const card = document.createElement("div");
    card.className = "help-card";
    const title = document.createElement("h4");
    title.textContent = group;
    const dl = document.createElement("dl");
    for (const [name, label, inGroup] of HELP_ACTIONS) {
      if (inGroup !== group) continue;
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = keys[name] || "не задана";
      if (!keys[name]) dd.classList.add("is-empty");
      dl.append(dt, dd);
    }
    card.append(title, dl);
    box.appendChild(card);
  }
}

// ───────────────────────────────────────────────── события

function bindEvents() {
  $("btn-min").addEventListener("click", () => window.api.minimize());
  $("btn-max").addEventListener("click", () => window.api.maximize());
  $("btn-close").addEventListener("click", () => window.api.close());

  // Компактный режим: кнопка в заголовке сворачивает окно, в самом окне —
  // разворачивает обратно. Управление дублирует главный экран.
  $("btn-compact").addEventListener("click", () => void setCompactMode(true));
  $("mini-expand").addEventListener("click", () => void setCompactMode(false));
  $("mini-close").addEventListener("click", () => window.api.close());
  $("mini-primary").addEventListener("click", () => void handlePrimary());
  $("mini-pause").addEventListener("click", () => void togglePause());
  $("mini-stop").addEventListener("click", () => {
    if (state.recording) void endRecording();
  });
  // Переключатели звука переиспользуют логику карточек: сохранение, индикация.
  $("mini-mic").addEventListener("click", () => $("sw-mic").click());
  $("mini-system").addEventListener("click", () => $("sw-system").click());
  $("mini-history").addEventListener("click", () => {
    void setCompactMode(false).then(() => showView("library"));
  });
  $("mini-settings").addEventListener("click", () => {
    void setCompactMode(false).then(() => showView("settings"));
  });

  document.querySelectorAll(".rail-btn").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });

  $("sel-source").addEventListener("change", (event) => {
    const selKey = state.mode === "audio" ? "screen" : state.mode;
    state.selected[selKey] = event.target.value;
    renderSources();
  });
  document.querySelectorAll("#library-filters .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      document.querySelectorAll("#library-filters .chip").forEach((item) => {
        item.classList.toggle("is-active", item === chip);
      });
      void renderLibrary();
    });
  });
  $("btn-pick-region").addEventListener("click", chooseRegion);
  $("btn-primary").addEventListener("click", () => void handlePrimary());
  $("btn-pause").addEventListener("click", () => togglePause());

  // Выпадающий список режимов: «Запись экрана», «Скриншот области» и т.д.
  $("mode-select-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("mode-menu");
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", (event) => {
    const menu = $("mode-menu");
    if (!menu || menu.hidden) return;
    if (!menu.contains(event.target) && event.target !== $("mode-select-btn")) {
      menu.hidden = true;
    }
  });
  document.querySelectorAll(".preset").forEach((button) => {
    button.addEventListener("click", () => {
      const [mode, action] = String(button.dataset.preset).split(":");
      state.mode = mode;
      state.action = action;
      $("mode-menu").hidden = true;
      // Выбрали «Выделить и записать видео» — всегда заново выделяем область и
      // начинаем писать: выделение и есть команда «пишем». Большая кнопка в
      // этом режиме, наоборот, пишет уже выбранную область без оверлея.
      if (mode === "region" && action === "video") {
        void (async () => {
          state.region = null;
          if (!(await chooseRegion())) return;
          await beginRecording();
        })();
      }
      void saveSetting({ captureAction: action });
      renderAction();
    });
  });

  // Нижняя строка панели.
  $("strip-autostop").addEventListener("click", () => {
    const order = [0, 1, 5, 10, 30];
    const current = Number(state.settings.autostopMin) || 0;
    const next = order[(order.indexOf(current) + 1) % order.length];
    void saveSetting({ autostopMin: next }).then(() => {
      $("sel-autostop").value = String(next);
      toast(next ? `Авто-остановка через ${next} мин` : "Авто-остановка выключена", "ok");
    });
  });
  $("strip-schedule").addEventListener("click", () => {
    showView("settings");
    document.querySelector('.snav[data-section="schedule"]')?.click();
  });
  $("strip-format").addEventListener("click", () => {
    showView("settings");
    document.querySelector('.snav[data-section="output"]')?.click();
  });
  // Быстрый переключатель «попадает ли окно приложения в запись»: раньше это
  // пряталось в настройках, и окно молча исчезало из кадра.
  $("strip-self").addEventListener("click", async () => {
    const hide = state.settings?.hideSelf === false;
    await saveSetting({ hideSelf: hide });
    await window.api.setContentProtection(hide).catch(() => {});
    updateStrip();
    toast(hide ? "Своё окно не попадает в запись" : "Своё окно попадает в запись", "ok");
  });
  $("strip-history").addEventListener("click", () => showView("library"));
  document.querySelectorAll("[data-back]").forEach((button) => {
    button.addEventListener("click", () => showView("capture"));
  });
  document.querySelectorAll("[data-open-dir]").forEach((button) => {
    button.addEventListener("click", () => window.api.openOutputDir());
  });
  $("btn-open-out").addEventListener("click", () => window.api.openOutputDir());

  $("btn-mic-test").addEventListener("click", () => void startMicTest());
  $("btn-camera-test").addEventListener("click", () => void startCameraTest());
  $("btn-camera-photo").addEventListener("click", () => void takeCameraPhoto());

  $("btn-open-log").addEventListener("click", async () => {
    const result = await window.api.openLogDir();
    if (!result?.ok) toast("Папка логов ещё не создана — начните запись", "error");
  });
  $("btn-copy-log").addEventListener("click", async () => {
    const lines = await window.api.logTail(120);
    if (!Array.isArray(lines) || !lines.length) {
      toast("Лог пока пуст", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast(`Скопировано строк лога: ${lines.length}`, "ok");
    } catch (err) {
      toast(`Не удалось скопировать: ${err.message}`, "error");
    }
  });

  for (const [id, key] of Object.entries(SWITCHES)) {
    const el = $(id);
    if (!el) {
      console.log(`bindEvents: нет элемента #${id}`);
      continue;
    }
    el.addEventListener("click", () => {
      const value = !state.settings[key];
      void saveSetting({ [key]: value }).then(() => {
        if (key === "hideSelf") void window.api.setContentProtection(value);
        // Микрофон и система: сразу включаем/гасим живую индикацию сигнала.
        if (key === "mic" || key === "systemAudio") {
          syncPreviewMeters();
          renderMini();
        }
        if (key === "watermarkOn" && value && !state.settings.watermarkText && !state.settings.watermarkImage) {
          toast("Задайте текст или PNG — иначе накладывать нечего", "error");
        }
      });
    });
  }

  $("sel-fps").addEventListener("change", (e) => void saveSetting({ fps: Number(e.target.value) }));
  $("sel-quality").addEventListener("change", (e) => void saveSetting({ quality: e.target.value }));
  $("sel-countdown").addEventListener("change", (e) => void saveSetting({ countdown: Number(e.target.value) }));
  $("sel-container").addEventListener("change", (e) => {
    void saveSetting({ videoContainer: e.target.value }).then(() => refreshCodecOptions());
  });
  $("sel-shotformat").addEventListener("change", (e) => void saveSetting({ screenshotFormat: e.target.value }));
  $("sel-audioformat").addEventListener("change", (e) => void saveSetting({ audioFormat: e.target.value }));
  for (const [rangeId, outId, key] of MIX_RANGES) {
    const range = $(rangeId);
    // Пока тянут ползунок — подпись и (если идёт запись) звук меняются сразу.
    range.addEventListener("input", () => {
      $(outId).textContent = `${range.value}%`;
      paintRange(range);
      if (state.recording) {
        recorder.setGains(key === "micVolume" ? { mic: Number(range.value) } : { system: Number(range.value) });
      }
    });
    range.addEventListener("change", () => void saveSetting({ [key]: Number(range.value) }));
  }
  $("sel-sysource").addEventListener("change", (e) => {
    const label = e.target.selectedOptions[0]?.textContent || "Windows";
    e.target.title = `Источник звука компьютера: ${label}`;
    void saveSetting({ systemSourceId: e.target.value }).then(() => {
      // Индикация и сам захват перестраиваются под новый источник.
      stopPreviewSystem();
      syncPreviewMeters();
      toast(
        e.target.value
          ? `Звук компьютера: ${label}. Направьте на этот вход звук из программы (например, из DAW).`
          : "Звук компьютера: весь системный звук Windows",
        "ok",
      );
    });
  });
  $("sel-micdevice").addEventListener("change", (e) => {
    void saveSetting({ micDeviceId: e.target.value });
    const label = e.target.selectedOptions[0]?.textContent || "по умолчанию";
    toast(`Аудиовход: ${label}`, "ok");
  });
  $("sel-outdevice").addEventListener("change", (e) => {
    void saveSetting({ outDeviceId: e.target.value });
    const label = e.target.selectedOptions[0]?.textContent || "по умолчанию";
    toast(
      e.target.value
        ? `Выбран выход: ${label}. Системный звук идёт с устройства по умолчанию — переключите его в Windows, чтобы писать с этого.`
        : "Системный звук: устройство вывода по умолчанию",
      "ok",
    );
  });
  $("sel-keyframe").addEventListener("change", (e) => void saveSetting({ keyframeSec: Number(e.target.value) }));
  $("sel-audioquality").addEventListener("change", (e) => void saveSetting({ audioQuality: Number(e.target.value) }));
  $("sel-samplerate").addEventListener("change", (e) => void saveSetting({ sampleRate: Number(e.target.value) }));
  $("sel-channels").addEventListener("change", (e) => void saveSetting({ channels: Number(e.target.value) }));
  $("sel-videocodec").addEventListener("change", (e) => void saveSetting({ videoCodec: e.target.value }));
  $("sel-audiocodec").addEventListener("change", (e) => void saveSetting({ audioCodec: e.target.value }));

  // Водяной знак. Текст пишется в настройки не на каждое нажатие: превью
  // обновляется сразу, а файл настроек — после паузы в наборе или по уходу
  // фокуса, иначе один набор текста даёт десятки записей settings.json.
  let wmTextTimer = 0;
  $("inp-wm-text").addEventListener("input", (event) => {
    const value = event.target.value;
    state.settings.watermarkText = value;
    renderWatermarkPreview();
    clearTimeout(wmTextTimer);
    wmTextTimer = setTimeout(() => void saveSetting({ watermarkText: value }), 500);
  });
  $("inp-wm-text").addEventListener("change", (event) => {
    clearTimeout(wmTextTimer);
    void saveSetting({ watermarkText: event.target.value });
  });
  $("sel-wm-position").addEventListener("change", (e) => void saveSetting({ watermarkPosition: e.target.value }));
  $("sel-wm-size").addEventListener("change", (e) => void saveSetting({ watermarkSize: Number(e.target.value) }));
  $("sel-wm-opacity").addEventListener("change", (e) => void saveSetting({ watermarkOpacity: Number(e.target.value) }));
  $("sel-wm-margin").addEventListener("change", (e) => void saveSetting({ watermarkMargin: Number(e.target.value) }));
  $("btn-wm-image").addEventListener("click", async () => {
    const picked = await window.api.chooseImage(state.settings.watermarkImage || "");
    if (!picked) return;
    await saveSetting({ watermarkImage: picked });
    toast(`Водяной знак: ${picked.split(/[\\/]/).pop()}`, "ok");
  });
  $("btn-wm-image-clear").addEventListener("click", async () => {
    if (!state.settings.watermarkImage) return;
    await saveSetting({ watermarkImage: "" });
    toast("Картинка водяного знака убрана", "ok");
  });

  $("btn-recent-all").addEventListener("click", () => showView("library"));
  $("btn-clear-library").addEventListener("click", clearLibraryUi);
  $("btn-recent-clear").addEventListener("click", clearLibraryUi);
  $("mini-library-clear").addEventListener("click", clearLibraryUi);
  $("btn-clear-selection").addEventListener("click", () => {
    state.selection.clear();
    void renderLibrary();
  });

  $("btn-schedule-arm").addEventListener("click", () => {
    const durationMin = Number($("sel-scheduration").value) || 0;
    if (scheduleMode() === "clock") {
      armSchedule({ mode: "clock", clock: clockFieldValue(), durationMin });
      return;
    }
    const delayMin = Number($("sel-schedelay").value) || 0;
    if (delayMin <= 0) {
      toast("Выберите, через сколько минут начать, или переключитесь на «в точное время»", "error");
      return;
    }
    armSchedule({ delayMin, durationMin });
  });
  $("btn-schedule-cancel").addEventListener("click", () => cancelSchedule(false));
  $("sel-schemode").addEventListener("change", () => refreshScheduleTarget());
  $("sel-schedelay").addEventListener("change", () => refreshScheduleTarget());
  $("inp-scheclock").addEventListener("change", () => refreshScheduleTarget());
  $("inp-scheclock").addEventListener("input", () => refreshScheduleTarget());

  $("btn-panorama").addEventListener("click", async () => {
    const shots = [...state.selection].filter((item) => /\.(png|jpe?g|bmp)$/i.test(item));
    if (shots.length < 2) return;
    const rows = await window.api.library();
    const ordered = rows
      .filter((row) => shots.includes(row.path))
      .sort((a, b) => a.mtime - b.mtime)
      .map((row) => row.path);
    const button = $("btn-panorama");
    button.textContent = "Собираю…";
    button.disabled = true;
    try {
      const panorama = await buildPanorama(ordered);
      const result = await window.api.saveAnnotated({
        dataUrl: panorama.dataUrl,
        format: "png",
        baseName: "panorama",
      });
      if (result?.ok) {
        toast(
          `Панорама ${panorama.width}×${panorama.height} · перекрытия ${panorama.overlaps.join("/")} px · ${formatSize(result.size)}`,
          "ok",
        );
        state.selection.clear();
        await renderLibrary();
      } else {
        toast(`Панорама не сохранена: ${result?.error || result?.reason}`, "error");
      }
    } catch (err) {
      toast(`Панорама не собралась: ${err.message}`, "error");
    } finally {
      button.textContent = "Панорама";
      paintSelectionBar();
    }
  });
  $("btn-merge").addEventListener("click", async () => {
    const videos = [...state.selection].filter((item) => /\.(mp4|webm|mkv|mov|wmv|f4v|ts)$/i.test(item));
    if (videos.length < 2) return;
    const rows = await window.api.library();
    // Склеиваем в хронологическом порядке, а не в порядке отображения.
    const paths = rows
      .filter((row) => state.selection.has(row.path) && row.kind === "video")
      .sort((a, b) => a.mtime - b.mtime)
      .map((row) => row.path);
    const button = $("btn-merge");
    button.textContent = "Склеиваю…";
    button.disabled = true;
    try {
      const result = await window.api.mergeMedia({ paths });
      if (result?.ok) {
        const name = result.path.split(/[\\/]/).pop();
        toast(`Склеено ${result.merged} файлов: ${name} · ${formatSize(result.size)}${result.audio ? "" : " · без звука"}`, "ok");
        state.selection.clear();
        await renderLibrary();
      } else {
        toast(`Склейка не удалась: ${result?.error || result?.reason}`, "error");
      }
    } finally {
      button.textContent = "Склеить выбранные";
      paintSelectionBar();
    }
  });
  $("sel-autostop").addEventListener("change", (e) => void saveSetting({ autostopMin: Number(e.target.value) }));
  $("sel-panelStyle").addEventListener("change", (e) => void saveSetting({ panelStyle: e.target.value }));

  document.querySelectorAll(".snav").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".snav").forEach((b) => b.classList.toggle("is-active", b === btn));
      document.querySelectorAll(".sect").forEach((sect) => {
        sect.classList.toggle("is-active", sect.id === `sect-${btn.dataset.section}`);
      });
      // Превью знака меряет ширину рамки — считаем его, когда раздел уже виден.
      if (btn.dataset.section === "mark") renderWatermarkPreview();
    });
  });

  $("btn-dir-video").addEventListener("click", async () => {
    const dir = await window.api.chooseDir(state.settings.outputDir);
    if (!dir) return;
    await saveSetting({ outputDir: dir });
    state.info.outputDir = dir;
    applySettingsToUi();
  });
  $("btn-dir-shots").addEventListener("click", async () => {
    const dir = await window.api.chooseDir(state.settings.outputDirShots || state.settings.outputDir);
    if (!dir) return;
    await saveSetting({ outputDirShots: dir });
    state.info.outputDirShots = dir;
    applySettingsToUi();
  });

  bindHotkeyEditor();

  // Оверлей области открылся: заранее открываем захват, чтобы после
  // подтверждения рамки запись началась сразу, а не через 5 секунд.
  window.api.onRegionDisplay?.((info) => {
    if (state.recording || !info?.displayId) return;
    const screen = state.sources.find(
      (s) => s.kind === "screen" && String(s.displayId) === String(info.displayId),
    );
    if (!screen) return;
    const target = {
      kind: "screen",
      sourceId: screen.id,
      displayId: info.displayId,
      systemAudio: loopbackWanted(),
    };
    void recorder
      .prewarm({
        target,
        fps: Number(state.settings?.fps) || 30,
        systemAudio: loopbackWanted(),
        arm: () => window.api.prewarmCapture({ target }),
      })
      .then((result) => {
        uiLog("info", `прогрев захвата области: ${result?.ok ? "ок" : result?.error || "нет"}`, "capture");
        if (!result?.ok) return;
        // Прогретый захват не должен висеть вечно: если запись так и не
        // началась (рамку выбрали, но кнопку не нажали), отпускаем его.
        clearTimeout(state.prewarmTimer);
        state.prewarmTimer = setTimeout(() => {
          state.prewarmTimer = null;
          if (state.recording) return;
          recorder.dropPrewarm();
          uiLog("info", "прогрев захвата области отпущен (запись не начата)", "capture");
        }, 60000);
      });
  });

  window.api.onHotkey((kind) => {
    uiLog("info", `горячая клавиша: ${kind}`, "hotkeys");
    if (kind === "toggle") {
      if (state.recording) void endRecording();
      else void beginRecording();
    } else if (kind === "stop") {
      if (state.recording) void endRecording();
    } else if (kind === "pause") {
      if (state.recording) togglePause();
    } else if (kind === "region") {
      void handleRegionHotkey();
    } else if (kind === "regionShot") {
      // Второе нажатие клавиши подтверждает уже нарисованную рамку снимка —
      // так же, как у «выделить и записать видео». Enter тоже работает.
      if (state.shotPending) {
        window.api.confirmRegion();
        return;
      }
      if (!state.recording && !state.busy) void takeRegionScreenshot();
    } else if (kind === "screenshot") {
      void takeScreenshot();
    } else if (kind === "library") {
      showView("library");
    } else if (kind === "mic") {
      void saveSetting({ mic: !state.settings.mic }).then(() => {
        toast(`Микрофон: ${state.settings.mic ? "вкл" : "выкл"}`, "ok");
      });
    } else if (kind === "panel") {
      void saveSetting({ showPanel: !state.settings.showPanel }).then(() => {
        toast(`Плавающая панель: ${state.settings.showPanel ? "вкл" : "выкл"}`, "ok");
      });
    }
  });

  window.api.onRecordCommand((command) => {
    state.recordCommands.push({ command, at: Date.now() });
    console.log(
      `record:command ${command} recording=${state.recording} busy=${state.busy}`,
    );
    if (command === "stop") {
      if (state.recording) void endRecording();
      else if (state.busy) pendingStop = true;
    } else if (command === "pause") togglePause();
  });

  window.api.onCursor((point) => recorder.setCursor(point));
  window.api.onPreviewProgress(handlePreviewProgress);

  // Автодоставка ffmpeg: свой не нашёлся — скачиваем в фоне и сообщаем сюда.
  window.api.onFfmpegState?.((event) => {
    if (state.recording) return; // запись важнее подсказок о загрузке
    if (event.phase === "start") {
      toast("ffmpeg не найден — скачиваю автоматически, это один раз (~100 МБ)");
      $("cap-hint").textContent = "Скачиваю ffmpeg… он нужен для MKV, GIF, склейки и обрезки";
    } else if (event.phase === "progress") {
      $("cap-hint").textContent = `Скачиваю ffmpeg… ${Number(event.percent) || 0}%`;
    } else if (event.phase === "ready") {
      toast("ffmpeg установлен — теперь доступны все форматы, склейка и обрезка", "ok");
      $("cap-hint").textContent = "ffmpeg установлен — все форматы доступны";
      void (async () => {
        state.info = await window.api.info();
        renderInfo();
        refreshCodecOptions();
      })();
    } else if (event.phase === "failed") {
      toast(`ffmpeg скачать не удалось (${event.error || "сеть"}) — доступны MP4 и WebM`, "error");
      $("cap-hint").textContent = "ffmpeg недоступен: перекоды в другие форматы отключены";
    }
  });

  window.addEventListener("keydown", (event) => {
    if ($("editor").hidden) return;
    if (event.key === "Escape") {
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
      else closeEditor();
      event.preventDefault();
      return;
    }
    // Пробел — как в любом плеере. В полях ввода и списках пробел остаётся
    // пробелом, поэтому их пропускаем.
    if (event.code === "Space" || event.key === " ") {
      // Автоповтор удержания переключал бы воспроизведение десятки раз в секунду.
      if (event.repeat) return;
      const tag = String(event.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      event.preventDefault();
      toggleEditorPlay();
      return;
    }
    // Ctrl+C — по физической клавише (event.code): в русской раскладке
    // event.key приходит как «с», и проверка на "c" не срабатывала.
    if ((event.ctrlKey || event.metaKey) && (event.code === "KeyC" || event.key.toLowerCase() === "c") && markup.ctx) {
      event.preventDefault();
      $("markup-clipboard").click();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.recording) void endRecording();
  });

  window.addEventListener("beforeunload", () => {
    if (deviceTest.mic.stream) stopMicTest();
    if (deviceTest.camera.stream) stopCameraTest();
  });

  window.api.onSelftest(runSelftest);
  window.api.onModeTest(runModeTests);
  window.api.onSelftestView((view) => showView(view));
  bindEditor();
  bindMarkup();
}

// ───────────────────────────────────────────────── самопроверка

async function runSelftest() {
  const report = { ok: false, steps: [], recordings: [] };
  try {
    await refreshSources();
    const screen = state.sources.find((s) => s.kind === "screen");
    if (!screen) throw new Error("нет экранов для записи");
    state.selected.screen = screen.id;
    await saveSetting({
      countdown: 0,
      mic: false,
      systemAudio: true,
      webcam: false,
      fps: 30,
      quality: "balanced",
      hideSelf: true,
      minimizeOnRecord: false,
      soundOnStart: false,
      showPanel: true,
      panelStyle: "full",
      cursorHighlight: true,
      videoContainer: "mkv",
      autostopMin: 0,
    });
    report.steps.push(`источников: ${state.sources.length}, экран: «${screen.name}»`);
    report.steps.push(`формат записи: ${pickMimeType() || "по умолчанию"}, контейнер на выходе: ${state.settings.videoContainer}`);
    report.steps.push(`hideSelf: ${state.settings.hideSelf}, cursorHighlight: ${state.settings.cursorHighlight}`);

    // 1. Весь экран, с паузой посередине (проверяем pause/resume и перекод в MKV)
    state.mode = "screen";
    renderSources();
    console.log("selftest: begin capture mode=screen");
    await beginRecording();
    if (!state.recording) throw new Error("запись не перешла в активное состояние");
    const fullInfo = state.lastInfo;
    await sleep(900);
    togglePause();
    const pausedAt = recorder.paused;
    await sleep(400);
    togglePause();
    await sleep(1500);
    const fullResult = await endRecording();
    if (!fullResult?.ok) throw new Error("экранная запись не сохранилась");
    report.recordings.push({
      mode: "screen",
      width: fullInfo?.width,
      height: fullInfo?.height,
      path: fullResult.path,
      size: fullResult.size,
      recordedMs: fullResult.recordedMs,
      converted: fullResult.converted,
      note: fullResult.note,
      pausedWorked: pausedAt === true && recorder.paused === false,
    });
    report.steps.push(
      `экран: ${fullInfo?.width}×${fullInfo?.height}, пауза: ${pausedAt === true}, в MKV: ${fullResult.converted}, файл ${fullResult.path.split(".").pop()}`,
    );

    // 2. Область — координаты заданы программно, без оверлея выделения
    state.mode = "region";
    const dpr = window.devicePixelRatio || 1;
    state.region = {
      x: 120,
      y: 120,
      width: 640,
      height: 360,
      displayId: screen.displayId,
      displaySize: { width: window.screen.width, height: window.screen.height },
      scaleFactor: dpr,
    };
    const region = await captureFor(2400);
    report.recordings.push({
      mode: "region",
      width: region.info?.width,
      height: region.info?.height,
      path: region.result?.path,
      size: region.result?.size,
      recordedMs: region.result?.recordedMs,
      dpr,
    });
    report.steps.push(`область 640×360 при dpr ${dpr}: получилось ${region.info?.width}×${region.info?.height}`);

    // 3. Обрезка и кадр из записанного файла
    if (region.result?.path) {
      const cut = await window.api.trimMedia({
        filePath: region.result.path,
        startSec: 0.5,
        endSec: 1.5,
        accurate: true,
      });
      report.trim = {
        ok: Boolean(cut?.ok),
        path: cut?.path,
        size: cut?.size,
        durationSec: cut?.durationSec,
        error: cut?.error,
      };
      const shot = await window.api.videoSnapshot({ filePath: region.result.path, atSec: 0.8 });
      report.snapshot = { ok: Boolean(shot?.ok), path: shot?.path, size: shot?.size };
      report.steps.push(`обрезка 0.5–1.5 с: ${cut?.ok ? "ok" : cut?.error || "fail"}, кадр: ${shot?.ok ? "ok" : "fail"}`);
    }

    // 3.5 Контейнер WMV из списка форматов
    await saveSetting({ videoContainer: "wmv" });
    const wmv = await captureFor(1400);
    report.wmv = { ok: Boolean(wmv.result?.ok), path: wmv.result?.path, note: wmv.result?.note, size: wmv.result?.size };
    report.steps.push(`контейнер WMV: ${wmv.result?.path ? wmv.result.path.split(".").pop() : wmv.result?.note}`);
    await saveSetting({ videoContainer: "auto" });

    // 3.6 Скриншот в BMP
    await saveSetting({ screenshotFormat: "bmp" });
    await takeScreenshot();
    const bmpRow = (await window.api.library()).find((r) => r.name.endsWith(".bmp"));
    report.screenshotBmp = { ok: Boolean(bmpRow), name: bmpRow?.name, size: bmpRow?.size };
    report.steps.push(`скриншот BMP: ${bmpRow ? "ok" : "fail"}`);
    await saveSetting({ screenshotFormat: "png" });

    // 3.65 Водяной знак: со знаком запись обязана перекодироваться, даже когда
    // контейнер «как у Chromium» — иначе знака в файле не было бы.
    await saveSetting({
      videoContainer: "mp4",
      watermarkOn: true,
      watermarkText: "SR",
      watermarkImage: "",
      watermarkSize: 48,
      watermarkOpacity: 1,
      watermarkMargin: 24,
      watermarkPosition: "bottom-right",
    });
    const wm = await captureFor(1400);
    report.watermark = {
      ok: Boolean(wm.result?.ok),
      path: wm.result?.path,
      size: wm.result?.size,
      converted: wm.result?.converted,
      note: wm.result?.note,
      enabledBeforeRecord: true,
    };
    report.steps.push(
      `водяной знак текстом: ${wm.result?.path ? wm.result.path.split(".").pop() : "fail"}, ` +
        `перекод ${wm.result?.converted === true ? "был" : "не было"}` +
        `${wm.result?.note ? `, замечание: ${wm.result.note}` : ""}`,
    );
    await saveSetting({ watermarkOn: false, watermarkText: "", videoContainer: "auto" });

    // 3.7 Только звук → MP3
    state.mode = "audio";
    renderSources();
    await saveSetting({ audioFormat: "mp3", mic: false, systemAudio: true });
    const audio = await captureFor(2000);
    report.audio = { ok: Boolean(audio.result?.ok), path: audio.result?.path, size: audio.result?.size };
    report.steps.push(`звук → ${audio.result?.path ? audio.result.path.split(".").pop() : "fail"}`);

    // 3.7b Звук компьютера с выбранного входа вместо loopback Windows (DAW на ASIO).
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default",
    );
    if (inputs.length) {
      await saveSetting({ systemSourceId: inputs[0].deviceId, mic: false, systemAudio: true });
      const viaDevice = await captureFor(2000);
      report.systemSource = {
        ok: Boolean(viaDevice.result?.ok),
        size: viaDevice.result?.size,
        device: inputs[0].label || inputs[0].deviceId,
      };
      await saveSetting({ systemSourceId: "" });
    } else {
      report.systemSource = { ok: null, note: "нет аудиовходов" };
    }
    report.steps.push(
      `звук компьютера с входа: ${report.systemSource.ok === null ? "пропущено" : report.systemSource.ok ? "ок" : "fail"}`,
    );
    state.mode = "screen";
    renderSources();

    // 3.8 Склейка двух клипов и смена скорости
    state.mode = "region";
    state.region = {
      x: 200,
      y: 200,
      width: 480,
      height: 270,
      displayId: screen.displayId,
      displaySize: { width: window.screen.width, height: window.screen.height },
      scaleFactor: window.devicePixelRatio || 1,
    };
    renderSources();
    const clipA = await captureFor(1200);
    const clipB = await captureFor(1200);
    const merged = await window.api.mergeMedia({ paths: [clipA.result.path, clipB.result.path] });
    report.merge = {
      ok: Boolean(merged?.ok),
      path: merged?.path,
      size: merged?.size,
      audio: merged?.audio,
      error: merged?.error,
    };
    if (merged?.ok) {
      const fast = await window.api.speedMedia({ filePath: merged.path, speed: 2 });
      report.speed = { ok: Boolean(fast?.ok), path: fast?.path, size: fast?.size, error: fast?.error };
      report.steps.push(`склейка 2 клипов: ${merged.ok ? "ok" : "fail"}, скорость 2×: ${fast?.ok ? "ok" : "fail"}`);
    } else {
      report.steps.push(`склейка: fail — ${merged?.error || merged?.reason}`);
    }
    state.region = null;
    state.mode = "screen";
    renderSources();

    // 3.9 Разметка скриншота: синтетический кадр → сохранение копии
    const probeCanvas = document.createElement("canvas");
    probeCanvas.width = 320;
    probeCanvas.height = 180;
    const probeCtx = probeCanvas.getContext("2d");
    probeCtx.fillStyle = "#101216";
    probeCtx.fillRect(0, 0, 320, 180);
    probeCtx.fillStyle = "#6ee7a8";
    probeCtx.fillRect(40, 40, 120, 60);
    probeCtx.strokeStyle = "#ff5a52";
    probeCtx.lineWidth = 6;
    probeCtx.beginPath();
    probeCtx.moveTo(200, 140);
    probeCtx.lineTo(290, 60);
    probeCtx.stroke();
    const annotated = await window.api.saveAnnotated({
      dataUrl: probeCanvas.toDataURL("image/png"),
      format: "png",
      baseName: "selftest-annotation",
    });
    report.annotate = { ok: Boolean(annotated?.ok), path: annotated?.path, size: annotated?.size };
    report.steps.push(`разметка → копия: ${annotated?.ok ? "ok" : "fail"}`);

    // 3.10 Кодек HEVC через ffmpeg
    await saveSetting({ videoContainer: "webm" });
    refreshCodecOptions();
    report.codecOptions = { webm: [...$("sel-videocodec").options].map((option) => option.value) };
    await saveSetting({ videoContainer: "mov" });
    refreshCodecOptions();
    report.codecOptions.mov = [...$("sel-videocodec").options].map((option) => option.value);
    report.steps.push(`кодеки по контейнерам: webm=[${report.codecOptions.webm}] mov=[${report.codecOptions.mov}]`);

    await saveSetting({ videoContainer: "mp4", videoCodec: "hevc", audioCodec: "aac" });
    const hevc = await captureFor(1200);
    report.hevc = { ok: Boolean(hevc.result?.ok), path: hevc.result?.path, note: hevc.result?.note };
    report.steps.push(`HEVC: ${hevc.result?.path ? hevc.result.path.split(".").pop() : hevc.result?.note}`);
    await saveSetting({ videoContainer: "auto", videoCodec: "auto", audioCodec: "auto" });

    // 3.11 Панорама из двух снимков со скроллом на 180 px
    const makePageShot = (offsetY) => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 300;
      const ctx = canvas.getContext("2d");
      for (let y = 0; y < 300; y += 10) {
        const pageY = y + offsetY;
        ctx.fillStyle = `rgb(${40 + (pageY % 200)}, ${(pageY * 3) % 200}, ${(pageY * 7) % 200})`;
        ctx.fillRect(0, y, 400, 10);
      }
      ctx.fillStyle = "#ff5a52";
      ctx.fillRect(24, 24, 60, 20);
      return canvas.toDataURL("image/png");
    };
    const shotA = await window.api.saveAnnotated({ dataUrl: makePageShot(0), format: "png", baseName: "pano-a" });
    const shotB = await window.api.saveAnnotated({ dataUrl: makePageShot(180), format: "png", baseName: "pano-b" });
    if (shotA?.ok && shotB?.ok) {
      const panorama = await buildPanorama([shotA.path, shotB.path]);
      report.panorama = {
        ok: true,
        width: panorama.width,
        height: panorama.height,
        overlaps: panorama.overlaps,
      };
      report.steps.push(
        `панорама ${panorama.width}×${panorama.height}, перекрытие ${panorama.overlaps[0]} px (ожидали 120)`,
      );
    } else {
      report.panorama = { ok: false };
      report.steps.push("панорама: fail — не удалось сохранить исходники");
    }

    // 3.12 Расписание: старт через 3 секунды
    if (state.recording) await endRecording();
    await window.api.abortCapture().catch(() => {});
    armSchedule({ delayMin: 0.05, durationMin: 0 });
    const scheduleDeadline = Date.now() + 15000;
    while (!state.recording && Date.now() < scheduleDeadline) await sleep(250);
    report.schedule = {
      started: state.recording,
      hint: $("cap-hint").textContent,
      stateText: $("schedule-state").textContent,
    };
    report.steps.push(`расписание: запись началась сама: ${state.recording}`);
    if (state.recording) await endRecording();
    cancelSchedule(true);

    // 3.13 Расписание «в точное время»: сегодня/завтра и текст цели
    const now = new Date();
    const inTwoMin = new Date(now.getTime() + 2 * 60_000);
    const backTwoMin = new Date(now.getTime() - 2 * 60_000);
    const clockText = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const ahead = resolveClockAt(clockText(inTwoMin), now);
    const behind = resolveClockAt(clockText(backTwoMin), now);
    $("sel-schemode").value = "clock";
    $("inp-scheclock").value = clockText(inTwoMin);
    refreshScheduleTarget();
    const targetText = $("schedule-at").textContent;
    const clockFieldShown = $("field-scheclock").hidden === false && $("field-schedelay").hidden === true;
    const armedClock = armSchedule({ mode: "clock", clock: clockText(inTwoMin), durationMin: 0 });
    const clockStateText = $("schedule-state").textContent;
    cancelSchedule(true);
    $("sel-schemode").value = "delay";
    refreshScheduleTarget();
    const delayFieldShown = $("field-schedelay").hidden === false && $("field-scheclock").hidden === true;
    report.scheduleClock = {
      aheadToday: ahead ? ahead.tomorrow === false : null,
      behindTomorrow: behind ? behind.tomorrow === true : null,
      armed: armedClock === true,
      targetText,
      stateText: clockStateText,
      clockFieldShown,
      delayFieldShown,
      badTimeRejected: resolveClockAt("25:99", now) === null,
    };
    report.steps.push(
      `расписание в точное время: сегодня=${report.scheduleClock.aheadToday}, завтра=${report.scheduleClock.behindTomorrow}, цель «${targetText}»`,
    );

    // 3.14 Проверка конфликтов клавиш до сохранения
    const toggleKey = state.settings?.hotkeys?.toggle || "F9";
    const duplicate = await window.api.checkHotkey({ name: "pause", accelerator: toggleKey });
    let free = { ok: false, reason: "нет свободного сочетания" };
    let freeAccelerator = "";
    for (const candidate of ["Control+Shift+F12", "Control+Alt+F11", "Control+Shift+F11", "Control+Alt+F10"]) {
      const checked = await window.api.checkHotkey({ name: "pause", accelerator: candidate });
      if (checked?.ok) {
        free = checked;
        freeAccelerator = candidate;
        break;
      }
      free = checked ?? free;
    }
    report.hotkeyCheck = {
      duplicate: duplicate?.reason,
      owner: duplicate?.owner,
      checked: toggleKey,
      freeOk: Boolean(free?.ok),
      freeAccelerator,
    };
    report.steps.push(
      `конфликт клавиш: ${toggleKey} → ${duplicate?.reason} (${duplicate?.owner}), ${freeAccelerator || "свободного нет"} → ok: ${Boolean(free?.ok)}`,
    );

    // 3.15 Прогресс прокси-предпросмотра на реальном MKV. force — чтобы кэш
    // не превратил проверку в одно событие «done».
    const mkvTime = report.recordings.find((row) => /\.mkv$/i.test(row.path || ""))?.path;
    if (mkvTime) {
      previewEvents.length = 0;
      const previewStarted = Date.now();
      const preview = await window.api.previewVideo({ filePath: mkvTime, force: true });
      report.previewProgress = {
        ok: Boolean(preview?.ok),
        events: previewEvents.length,
        phases: [...new Set(previewEvents.map((event) => event.phase))],
        tookMs: Date.now() - previewStarted,
        note: preview?.note,
        error: preview?.error,
      };
      report.steps.push(
        `прокси-предпросмотр: ${report.previewProgress.events} событий (${report.previewProgress.phases.join("/")}) за ${report.previewProgress.tookMs} мс`,
      );
    } else {
      report.previewProgress = { ok: false, events: 0, error: "нет MKV для проверки прокси" };
      report.steps.push("прокси-предпросмотр: fail — в прогоне не оказалось MKV");
    }

    // 3.16 Лог, минидампы и коды ошибок
    const infoNow = await window.api.info();
    const logLines = await window.api.logTail(40);
    const badPreview = await window.api.previewVideo({ filePath: "C:\\__нет_такого_файла__.mkv" });
    report.diagnostics = {
      logPath: infoNow.logPath || null,
      logDir: infoNow.logDir || null,
      crashDumps: infoNow.crashDumps || null,
      logLines: Array.isArray(logLines) ? logLines.length : 0,
      logHasCapture: Array.isArray(logLines) && logLines.some((line) => /\[(INF|WRN|ERR)\]\[(capture|app|preview|ui)\]/.test(line)),
      logSample: Array.isArray(logLines) ? logLines.slice(-2) : [],
      missingPreviewOk: badPreview?.ok === true,
      missingPreviewCode: badPreview?.code || null,
      hotkeyActions: Object.keys(state.settings.hotkeys || {}).length,
    };
    report.steps.push(
      `диагностика: лог «${String(infoNow.logPath || "нет").split("\\").pop()}», строк ${report.diagnostics.logLines}, код пропавшего файла ${report.diagnostics.missingPreviewCode}, действий с клавишами ${report.diagnostics.hotkeyActions}`,
    );

    // 3.17 Тест микрофона и камеры в плитках
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const hasMic = devices.some((device) => device.kind === "audioinput");
    const hasCam = devices.some((device) => device.kind === "videoinput");
    let micLevelVisible = false;
    let micOpened = false;
    if (hasMic) {
      micOpened = (await startMicTest()) === true;
      await sleep(1400);
      micLevelVisible = micOpened && $("mic-level").hidden === false && Boolean(deviceTest.mic.stream);
      stopMicTest();
    }
    let cameraVisible = false;
    let cameraPhoto = null;
    if (hasCam) {
      await startCameraTest();
      await sleep(900);
      cameraVisible = $("camera-preview-wrap").hidden === false && ($("camera-preview").videoWidth || 0) > 0;
      if (cameraVisible) cameraPhoto = await takeCameraPhoto();
      stopCameraTest();
    }
    report.deviceTest = {
      hasMic,
      hasCam,
      micOpened,
      micLevelVisible,
      cameraVisible,
      photoOk: Boolean(cameraPhoto?.ok),
      photoName: cameraPhoto?.path ? String(cameraPhoto.path).split(/[\\/]/).pop() : null,
      code: cameraPhoto?.code || null,
    };
    report.steps.push(
      `устройства: микрофон ${hasMic ? (micOpened ? "открылся" : "есть, но не открылся") : "нет"}, камера ${hasCam ? "есть" : "нет"}, уровень ${micLevelVisible ? "виден" : "нет"}, превью ${cameraVisible ? "есть" : "не проверялось (нет камеры)"}, фото ${report.deviceTest.photoName || "нет"}`,
    );

    // 4. Авто-остановка: запись должна прекратиться сама
    if (state.recording) await endRecording();
    await window.api.abortCapture().catch(() => {});
    await saveSetting({ autostopMin: 0.1 });
    const autostopInSettings = (await window.api.getSettings())?.autostopMin;
    state.mode = "screen";
    state.region = null;
    renderSources();
    state.recordCommands.length = 0;
    console.log("selftest: begin capture mode=screen (autostop)");
    const autostopStartedAt = Date.now();
    await beginRecording();
    const autostartOk = state.recording;
    console.log(
      `selftest: autostop armed=${state.lastStart?.autostopMin} settings=${autostopInSettings} recording=${state.recording}`,
    );
    // Ждём факта остановки, а не фиксированные секунды. Запас 30 с: сигнал
    // приходит через 6 с, но остановка записи на этой машине (финальный чанк +
    // ffmpeg) занимает ещё ~10 с, поэтому старые 14 с давали ложный «не встал».
    const autostopDeadline = Date.now() + 30000;
    let autostopBeat = 0;
    while (state.recording && Date.now() < autostopDeadline) {
      await sleep(300);
      if (++autostopBeat % 10 === 0) {
        console.log(
          `selftest: autostop wait ${Date.now() - autostopStartedAt} ms, recording=${state.recording}, commands=${JSON.stringify(state.recordCommands)}`,
        );
      }
    }
    const autostopStoppedAfterMs = Date.now() - autostopStartedAt;
    report.autostop = {
      started: autostartOk,
      stillRecordingAfterWait: state.recording,
      stoppedAfterMs: autostopStoppedAfterMs,
      armedInMain: state.lastStart?.autostopMin ?? null,
      settingsAutostopMin: autostopInSettings ?? null,
      commands: state.recordCommands.map((entry) => entry.command),
    };
    report.steps.push(
      `авто-стоп 6 с: запись сама остановилась: ${!state.recording} (через ${formatDelay(autostopStoppedAfterMs)}), main взял ${state.lastStart?.autostopMin}, команды: ${report.autostop.commands.join(",") || "нет"}`,
    );
    if (state.recording) await endRecording();

    await saveSetting({ videoContainer: "auto", autostopMin: 0 });
    report.ok =
      report.recordings.every((row) => Boolean(row.path)) &&
      !report.autostop.stillRecordingAfterWait &&
      report.autostop.commands.includes("stop") &&
      report.scheduleClock?.aheadToday === true &&
      report.scheduleClock?.behindTomorrow === true &&
      report.scheduleClock?.armed === true &&
      report.scheduleClock?.clockFieldShown === true &&
      report.scheduleClock?.delayFieldShown === true &&
      report.scheduleClock?.badTimeRejected === true &&
      report.hotkeyCheck?.duplicate === "duplicate" &&
      report.hotkeyCheck?.owner === "toggle" &&
      report.hotkeyCheck?.freeOk === true &&
      report.previewProgress?.ok === true &&
      report.previewProgress?.events >= 2 &&
      report.diagnostics?.logLines > 0 &&
      report.diagnostics?.logHasCapture === true &&
      report.diagnostics?.missingPreviewCode === "SR3001" &&
      report.diagnostics?.missingPreviewOk === false &&
      report.diagnostics?.hotkeyActions >= 9 &&
      report.watermark?.converted === true &&
      report.watermark?.note == null &&
      /\.mp4$/i.test(report.watermark?.path || "") &&
      (report.deviceTest?.hasMic ? (report.deviceTest.micOpened ? report.deviceTest.micLevelVisible === true : true) : true) &&
      (report.deviceTest?.hasCam ? report.deviceTest.cameraVisible === true && report.deviceTest.photoOk === true : true);
  } catch (err) {
    report.error = String(err?.message || err);
  }
  try {
    const rows = await window.api.library();
    report.library = rows.slice(0, 4).map((r) => ({ name: r.name, size: r.size, kind: r.kind }));
  } catch {
    report.library = [];
  }
  await window.api.selftestReport(report);
}

async function captureFor(ms) {
  console.log(`selftest: begin capture mode=${state.mode}`);
  await beginRecording();
  console.log(`selftest: recording=${state.recording} info=${JSON.stringify(state.lastInfo)}`);
  if (!state.recording) throw new Error("запись не перешла в активное состояние");
  const info = state.lastInfo;
  await sleep(ms);
  const result = await endRecording();
  console.log(`selftest: stopped -> ${JSON.stringify(result)}`);
  return { info, result };
}

async function runModeTests() {
  const report = { ok: false, modes: [], steps: [] };
  // Прогон меняет настройки под себя; запоминаем их, чтобы не затирать
  // пользовательские («своё окно», формат, показ панели и т.д.).
  const restoreKeys = [
    "countdown",
    "mic",
    "systemAudio",
    "webcam",
    "fps",
    "quality",
    "hideSelf",
    "minimizeOnRecord",
    "showPanel",
    "cursorHighlight",
    "videoContainer",
    "videoCodec",
    "audioCodec",
    "autostopMin",
  ];
  const before = { ...(state.settings || {}) };
  const restoreSettings = {};
  for (const key of restoreKeys) if (key in before) restoreSettings[key] = before[key];
  try {
    await saveSetting({
      countdown: 0,
      mic: false,
      systemAudio: true,
      webcam: false,
      fps: 30,
      quality: "balanced",
      hideSelf: true,
      minimizeOnRecord: false,
      showPanel: false,
      cursorHighlight: false,
      videoContainer: "auto",
      videoCodec: "auto",
      audioCodec: "auto",
      autostopMin: 0,
    });

    await refreshSources();

    // 1. Весь экран
    state.mode = "screen";
    state.region = null;
    renderSources();
    const full = await captureFor(2000);
    report.modes.push({
      mode: "screen",
      width: full.info?.width,
      height: full.info?.height,
      path: full.result?.path,
      size: full.result?.size,
    });

    // 2. Окно: цель — специальное окно 640×480, созданное main-процессом
    await refreshSources();
    report.windows = state.sources.filter((s) => s.kind === "window").map((s) => s.name).slice(0, 12);
    const target = state.sources.find((s) => s.kind === "window" && /SR test target/i.test(s.name));
    if (!target) throw new Error("тестовое окно не найдено в списке источников");
    state.mode = "window";
    state.selected.window = target.id;
    renderSources();
    const winRec = await captureFor(2000);
    // Проверяем главное для этого режима: системный звук пришёл второй сессией.
    const winProbe = winRec.result?.path
      ? await window.api.probeMedia({ filePath: winRec.result.path }).catch(() => null)
      : null;
    report.windowAudio = {
      hasAudio: Boolean(winProbe?.hasAudio),
      warnings: winRec.info?.warnings ?? [],
      probe: winProbe ? { duration: winProbe.duration, hasAudio: winProbe.hasAudio } : null,
    };
    report.modes.push({
      mode: "window",
      name: target.name,
      width: winRec.info?.width,
      height: winRec.info?.height,
      path: winRec.result?.path,
      size: winRec.result?.size,
      hasAudio: Boolean(winProbe?.hasAudio),
    });

    // 3. Область: настоящий оверлей, перетаскивание эмулирует main
    state.mode = "region";
    renderSources();
    await chooseRegion();
    report.regionPicked = state.region
      ? {
          x: state.region.x,
          y: state.region.y,
          width: state.region.width,
          height: state.region.height,
        }
      : null;
    if (!state.region) throw new Error("оверлей не вернул область");
    const reg = await captureFor(2000);
    report.modes.push({
      mode: "region",
      width: reg.info?.width,
      height: reg.info?.height,
      path: reg.result?.path,
      size: reg.result?.size,
    });

    // 4. Отмена выделения по Esc
    const cancelTry = await window.api.pickRegion();
    report.regionCancel = { ok: cancelTry?.ok, reason: cancelTry?.reason };

    // 4.5 «Выделить и записать видео»: выделение и старт записи одной командой.
    // Оверлей снова рисует main, поэтому проверка идёт без участия человека.
    state.mode = "screen";
    state.region = null;
    state.action = "video";
    renderAction();
    const regionHotkeyRun = handleRegionHotkey();
    const hotkeyDeadline = Date.now() + 30_000;
    while (!state.recording && Date.now() < hotkeyDeadline) await sleep(200);
    const hotkeyStarted = state.recording;
    const hotkeyInfo = state.lastInfo;
    let hotkeyResult = null;
    if (hotkeyStarted) {
      await sleep(1400);
      hotkeyResult = await endRecording();
    }
    await regionHotkeyRun.catch(() => {});
    report.regionHotkey = {
      started: hotkeyStarted,
      region: state.region
        ? { width: Math.round(state.region.width), height: Math.round(state.region.height) }
        : null,
      width: hotkeyInfo?.width,
      height: hotkeyInfo?.height,
      path: hotkeyResult?.path,
      ok: Boolean(hotkeyResult?.ok),
    };

    // 5. Скриншот из UI
    await saveSetting({ screenshotFormat: "png", showPanel: false });
    state.mode = "screen";
    state.region = null;
    renderSources();
    await takeScreenshot();
    const shotRows = (await window.api.library()).filter((row) => row.kind === "shot");
    report.screenshot = shotRows[0] ? { name: shotRows[0].name, size: shotRows[0].size } : null;

    // 6. Снимок области как в «Ножницах»: выделение → картинка в редакторе → копирование
    await window.api.selfProtect(false).catch(() => {});
    state.mode = "region";
    renderSources();
    await takeRegionScreenshot();
    await sleep(700);
    report.regionShot = {
      editorOpen: !$("editor").hidden,
      canvas: markup.canvas ? { width: markup.canvas.width, height: markup.canvas.height } : null,
    };
    if (markup.ctx) {
      const editorWasOpen = !$("editor").hidden;
      $("markup-clipboard").click();
      await sleep(1200);
      report.copyResult = {
        clicked: editorWasOpen,
        editorClosed: $("editor").hidden,
        toast: $("toast").hidden ? "" : $("toast").textContent,
      };
    }
    await sleep(200);
    closeEditor();
    await window.api.selfProtect(Boolean(state.settings.hideSelf)).catch(() => {});

    // 7. Скриншот своего окна (защита от захвата снимается на время снимка)
    await refreshSources();
    const ownWindow = state.sources.find((s) => s.kind === "window" && /Screen Revesane/i.test(s.name));
    report.ownWindowFound = Boolean(ownWindow);
    if (ownWindow) {
      state.mode = "window";
      state.selected.window = ownWindow.id;
      renderSources();
      await takeScreenshot();
      const shots = (await window.api.library()).filter((row) => row.kind === "shot");
      report.selfShot = shots[0] ? { name: shots[0].name, size: shots[0].size } : null;
    }

    // 8. Реальный путь: свёрнутое окно + плавающая панель + отсчёт
    await saveSetting({ countdown: 1, minimizeOnRecord: true, showPanel: true, systemAudio: true });
    state.mode = "screen";
    state.region = null;
    renderSources();
    const minimized = await captureFor(4000);
    report.minimized = {
      width: minimized.info?.width,
      height: minimized.info?.height,
      path: minimized.result?.path,
      size: minimized.result?.size,
      recordedMs: minimized.result?.recordedMs,
    };

    // 5. Видимое окно, но исключённое из записи (свежий дефолт)
    await saveSetting({ countdown: 0, minimizeOnRecord: false, showPanel: true });
    const visible = await captureFor(3000);
    report.visible = {
      width: visible.info?.width,
      height: visible.info?.height,
      path: visible.result?.path,
      size: visible.result?.size,
      recordedMs: visible.result?.recordedMs,
    };

    // 6. Назначение горячей клавиши нажатием (настройки → Клавиши)
    showView("settings");
    await sleep(400);
    const hkButton = document.querySelector('.hk[data-hk="region"]');
    if (hkButton) {
      // Запоминаем прежнюю привязку и возвращаем именно её: раньше тест
      // возвращал жёсткий F7 и затирал клавишу, выбранную пользователем.
      const previousRegion = state.settings?.hotkeys?.region || "";
      hkButton.click();
      await sleep(150);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", ctrlKey: true, bubbles: true }));
      await sleep(700);
      report.hotkeyCapture = {
        text: hkButton.textContent,
        saved: state.settings?.hotkeys?.region,
        restored: previousRegion,
        items: [...document.querySelectorAll(".hk")].map((item) => `${item.dataset.hk}:${item.textContent}`),
      };
      await saveSetting({ hotkeys: { ...(state.settings.hotkeys || {}), region: previousRegion } });
      renderHotkeys();
    }
    showView("capture");
    // Возвращаем настройки, которые прогон менял под себя: иначе после теста
    // у пользователя оставались hideSelf=true и «как у Chromium» вместо его
    // собственных значений.
    if (Object.keys(restoreSettings).length) {
      await saveSetting(restoreSettings);
      await window.api.selfProtect(Boolean(state.settings.hideSelf)).catch(() => {});
      uiLog("info", "самотест вернул прежние настройки", "selftest");
    }
    report.steps.push(`экран: ${report.modes[0].width}×${report.modes[0].height}`);
    report.steps.push(`окно: ${report.modes[1].width}×${report.modes[1].height}`);
    report.steps.push(
      `область: выделено ${report.regionPicked.width}×${report.regionPicked.height}, записано ${report.modes[2].width}×${report.modes[2].height}`,
    );
    report.steps.push(
      `F7 область → запись: ${report.regionHotkey?.started ? "началась сама" : "не началась"}, кадр ${report.regionHotkey?.width || "?"}×${report.regionHotkey?.height || "?"}, файл ${report.regionHotkey?.path ? report.regionHotkey.path.split(".").pop() : "нет"}`,
    );
    report.steps.push(`свёрнутое окно: ${formatClock(report.minimized.recordedMs || 0)}`);
    report.steps.push(`видимое окно: ${formatClock(report.visible.recordedMs || 0)}`);
    report.steps.push(`отмена Esc: ${report.regionCancel?.ok === false ? "ок" : "не сработала"}`);
    report.steps.push(`скриншот: ${report.screenshot ? formatSize(report.screenshot.size) : "нет"}`);
    report.steps.push(
      `снимок области: редактор ${report.regionShot?.editorOpen ? "открыт" : "не открыт"}, canvas ${report.regionShot?.canvas ? `${report.regionShot.canvas.width}×${report.regionShot.canvas.height}` : "нет"}`,
    );
    report.steps.push(`своё окно в списке: ${report.ownWindowFound ? "есть" : "нет"}, снимок ${report.selfShot ? formatSize(report.selfShot.size) : "нет"}`);
    report.steps.push(`назначение клавиши: ${report.hotkeyCapture?.saved || "нет"}`);
    report.steps.push(
      `звук окна: ${report.windowAudio?.hasAudio ? "AAC-дорожка на месте" : "нет дорожки"}${report.windowAudio?.warnings?.length ? ` (${report.windowAudio.warnings.join("; ")})` : ""}`,
    );

    report.ok =
      report.modes.length === 3 &&
      report.modes.every((row) => Boolean(row.path)) &&
      report.windowAudio?.hasAudio === true &&
      report.regionCancel?.ok === false &&
      report.regionHotkey?.started === true &&
      report.regionHotkey?.ok === true &&
      Boolean(report.regionHotkey?.width) &&
      Boolean(report.screenshot?.size) &&
      Boolean(report.regionShot?.canvas) &&
      Boolean(report.copyResult?.editorClosed) &&
      report.hotkeyCapture?.saved === "Control+F6" &&
      Boolean(report.selfShot?.size) &&
      Boolean(report.minimized?.path) &&
      Boolean(report.visible?.path);
  } catch (err) {
    report.error = String(err?.message || err);
  }
  try {
    await window.api.selftestReport(report);
  } catch (err) {
    console.log(`MODES REPORT FAILED: ${err?.message || err}`);
  }
}

// ───────────────────────────────────────────────── старт

async function boot() {
  state.settings = await window.api.getSettings();
  state.info = await window.api.info();
  state.action = state.settings.captureAction === "shot" ? "shot" : "video";
  if (state.action === "shot" && state.mode === "audio") state.mode = "screen";
  applySettingsToUi();
  await renderInfo();
  bindEvents();
  refreshScheduleTarget();
  renderAction();
  await refreshSources();
  void checkCamera();
  setRailState("готов", "ok");
  // История на главной должна быть заполнена сразу, а не после захода в библиотеку.
  void renderLibrary();
  // Если микрофон или система включены, полосы должны показывать сигнал сразу,
  // а не только после старта записи.
  syncPreviewMeters();
  renderMini();
}

/** Показывает в плитке, есть ли камера. */
async function checkCamera() {
  const note = $("camera-note");
  if (!note) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    const mic = devices.filter((device) => device.kind === "audioinput");
    const label = String(cameras[0]?.label || "").slice(0, 22);
    note.textContent = cameras.length
      ? `${cameras.length} камер(ы)${label ? ` · ${label}` : ""}`
      : "камера не найдена";
    const micNote = $("mic-note");
    if (micNote && !deviceTest.mic.stream) {
      micNote.textContent = mic.length ? "голос" : "микрофон не найден";
    }
  } catch {
    note.textContent = "камера недоступна";
  }
}

void boot().catch((err) => {
  console.log(`BOOT FAILED: ${err?.stack || err}`);
});
