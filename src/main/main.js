"use strict";

const {
  app, BrowserWindow, Menu, clipboard, crashReporter, desktopCapturer, dialog, globalShortcut, ipcMain,
  nativeImage, net, screen, session, shell,
} = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const log = require("./log");
const watermark = require("./watermark");
const ffmpegFetch = require("./ffmpeg-fetch");
const updater = require("./updater");
const I18N = require("../i18n/i18n.js");

// Кадры и таймеры не должны замирать, когда окно свёрнуто или спрятано:
// запись идёт в setInterval-цикле renderer-а.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

// Локальные минидампы: падение main или renderer оставит файл в каталоге
// crashDumps рядом с настройками, отправка на сервер не нужна.
let CRASH_DUMPS_DIR = null;
try {
  crashReporter.start({
    productName: "Screen Revesane",
    companyName: "Screen Revesane",
    submitURL: "",
    uploadToServer: false,
    compress: false,
    ignoreSystemCrashHandler: false,
  });
  CRASH_DUMPS_DIR = app.getPath("crashDumps");
} catch {
  /* без дампов приложение работает */
}

const SELFTEST = process.argv.includes("--selftest");
const SELFTEST_MODES = process.argv.includes("--selftest-modes");
const UI_SHOTS = process.argv.includes("--ui-shots");
const ROOT = path.join(__dirname, "..", "..");
/** Иконка окна: лежит внутри src, поэтому едет с любой сборкой и не зависит от кэша значков Windows. */
const APP_ICON = path.join(ROOT, "src", "assets", "icon.png");
const OUTPUT_DIR = path.join(app.getPath("videos"), "Screen Revesane");
const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");
/** Куда складывается автоматически скачанный ffmpeg, если своего нет в PATH. */
const TOOLS_DIR = path.join(app.getPath("userData"), "tools");
/** Loopback-звук экрана умеет отдавать только Windows: на macOS системный
 * звук пишется с виртуального устройства (BlackHole), выбранного источником. */
const LOOPBACK_SUPPORTED = process.platform === "win32";

/**
 * Коды ошибок: пользователь видит код, лог — расшифровку и контекст.
 * Диапазоны: 1xxx запись, 2xxx файл и конвертация, 3xxx предпросмотр,
 * 4xxx снимки, 5xxx внешние инструменты (ffmpeg).
 */
const CODES = {
  SR1001: "не удалось открыть файл записи",
  SR1002: "не выбран источник захвата",
  SR1003: "запись уже идёт",
  SR1004: "остановка без активной записи",
  SR2001: "пустой файл записи",
  SR2002: "перекод/ремукс не удался — файл сохранён как есть",
  SR2003: "не удалось убрать суффикс .part",
  SR3001: "предпросмотр не собрался",
  SR4001: "снимок не сохранён",
  SR5001: "ffmpeg недоступен",
};

function fail(code, extra = {}) {
  return { ok: false, code, message: CODES[code] ? I18N.t(CODES[code]) : null, ...extra };
}

const DEFAULT_SETTINGS = {
  fps: 30,
  quality: "balanced",
  mic: false,
  systemAudio: true,
  webcam: false,
  countdown: 3,
  captureAction: "video",
  hideSelf: true,
  minimizeOnRecord: false,
  // Матрица вывода: auto — как отдаёт Chromium, иначе перекод/ремукс через ffmpeg.
  videoContainer: "auto",
  videoCodec: "auto",
  audioCodec: "auto",
  screenshotFormat: "png",
  // WAV по умолчанию: «только звук» пишется без потерь, пережать всегда успеется.
  audioFormat: "wav",
  audioQuality: 320,
  sampleRate: 0,
  channels: 0,
  // Выбранные аудиоустройства (deviceId из enumerateDevices); пусто — системные.
  micDeviceId: "",
  outDeviceId: "",
  // Откуда брать звук компьютера: пусто — loopback Windows, иначе deviceId входа
  // (интерфейс, виртуальный кабель). DAW на ASIO в микшер Windows не попадает.
  systemSourceId: "",
  // Баланс в видео, %: 100 — как пришло. Очистка голоса — эхо/шум/автоусиление Chromium.
  micVolume: 100,
  systemVolume: 100,
  micCleanup: true,
  keyframeSec: 1,
  autostopMin: 0,
  // Водяной знак накладывается при перекоде (см. src/main/watermark.js).
  watermarkOn: false,
  watermarkText: "",
  watermarkImage: "",
  watermarkPosition: "bottom-right",
  watermarkSize: 28,
  watermarkOpacity: 0.85,
  watermarkShadow: true,
  watermarkMargin: 24,
  cursorHighlight: false,
  soundOnStart: true,
  showPanel: true,
  panelStyle: "full",
  hotkeys: { toggle: "F9", pause: "F8", screenshot: "F10", region: "F7", regionShot: "F6", stop: "", library: "", mic: "", panel: "" },
  outputDir: OUTPUT_DIR,
  outputDirShots: "",
  // авто = язык системы
  language: "auto",
  // Тур по программе показывается при первом запуске.
  tourDone: false,
  smartTips: true,
  // Подсказки, которые человек попросил больше не показывать.
  tipsDismissed: [],
  // Обновления: проверять при запуске и раз в 6 часов; пропущенная версия.
  checkUpdates: true,
  skipVersion: "",
};

let mainWindow = null;
let testTargetWindow = null;
let testTargetInfo = null;
let regionWindow = null;
let regionResolve = null;
let regionFinish = null;
let regionAttempts = 0;
/** Что делает прогон самопроверки с очередным оверлеем области. */
const REGION_SCRIPT = ["drag", "cancel", "drag", "drag"];
/**
 * Пауза между закрытием оверлея области и началом захвата. За один кадр
 * композитор успевает убрать оверлей, иначе он попадает в снимок/запись.
 */
const OVERLAY_CLEAR_MS = 260;
let ffmpegPath = null;
let ffprobePath = null;

/** Текущая запись: цель захвата и открытый файловый поток. */
const capture = {
  active: false,
  target: null,       // {sourceId, kind, displayId, displaySize}
  filePath: null,
  partPath: null,      // куда пишем на самом деле (<имя>.part.<ext>)
  ext: ".webm",
  stream: null,
  startedAt: 0,
  audio: false,
  selfVisible: false,
  autostopMin: 0,     // из настроек на момент старта
  autostopArmedAt: 0, // когда реально взведён таймер (по первому чанку)
  autostopTimer: null,
  audioTarget: null,  // следующая заявка getDisplayMedia — только системный звук с экрана
  prewarmTarget: null, // следующая заявка getDisplayMedia — прогрев захвата под область
};

// ─────────────────────────────────────────────────────────── настройки

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    const merged = { ...DEFAULT_SETTINGS, ...raw };
    // Клавиши сливаем по действиям: иначе новый набор действий (или новая
    // раскладка по умолчанию) не появится у тех, у кого уже есть settings.json.
    merged.hotkeys = { ...DEFAULT_SETTINGS.hotkeys, ...(raw.hotkeys || {}) };
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS, hotkeys: { ...DEFAULT_SETTINGS.hotkeys } };
  }
}

async function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fsp.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** Язык интерфейса: явный выбор пользователя, иначе язык системы. */
function resolveLang(pref) {
  if (pref === "ru" || pref === "en") return pref;
  return String(app.getLocale() || "").toLowerCase().startsWith("ru") ? "ru" : "en";
}

function outputDir() {
  const s = readSettings();
  return s.outputDir || OUTPUT_DIR;
}

function shotsDir() {
  const s = readSettings();
  return s.outputDirShots || outputDir();
}

/**
 * Матрица вывода (MP4/MKV/MOV/GIF…), но честно: Chromium пишет
 * mp4/webm, остальные контейнеры получаются перекодом через ffmpeg.
 */
const CONTAINER_ARGS = {
  mp4: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"],
  mkv: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k"],
  mov: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"],
  webm: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1", "-c:a", "libopus", "-b:a", "128k"],
  wmv: ["-c:v", "wmv2", "-b:v", "8M", "-c:a", "wmav2", "-b:a", "192k", "-f", "asf"],
  f4v: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-f", "mp4"],
  ts: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-f", "mpegts"],
  gif: null, // GIF собирается отдельным фильтром
};

const CONTAINER_EXT = {
  mp4: ".mp4",
  mkv: ".mkv",
  mov: ".mov",
  webm: ".webm",
  gif: ".gif",
  wmv: ".wmv",
  f4v: ".f4v",
  ts: ".ts",
  mpegts: ".ts",
};

/** Кодеки, доступные в этом ffmpeg (проверено: libx264, libx265, prores_ks, mpeg4, libvpx-vp9). */
const VIDEO_CODECS = {
  h264: { label: "H.264", args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"] },
  hevc: { label: "HEVC (H.265)", args: ["-c:v", "libx265", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"] },
  mpeg4: { label: "MPEG-4 (XVID-совместимый)", args: ["-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p"] },
  prores: { label: "ProRes", args: ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"] },
  vp9: { label: "VP9", args: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1"] },
  vp8: { label: "VP8", args: ["-c:v", "libvpx", "-b:v", "6M", "-crf", "10"] },
  wmv2: { label: "WMV2", args: ["-c:v", "wmv2", "-b:v", "8M"] },
};

const AUDIO_CODECS = {
  aac: { label: "AAC", args: (br) => ["-c:a", "aac", "-b:a", br] },
  ac3: { label: "AC3", args: (br) => ["-c:a", "ac3", "-b:a", br] },
  mp3: { label: "MP3", args: (br) => ["-c:a", "libmp3lame", "-b:a", br] },
  opus: { label: "Opus", args: () => ["-c:a", "libopus", "-b:a", "160k"] },
  wmav2: { label: "WMA", args: (br) => ["-c:a", "wmav2", "-b:a", br] },
  pcm: { label: "PCM (без сжатия)", args: () => ["-c:a", "pcm_s16le"] },
};

/** Что с чем совместимо: контейнер → допустимые видео- и аудиокодеки. */
const CONTAINER_CODECS = {
  mp4: { video: ["h264", "hevc", "mpeg4"], audio: ["aac", "ac3", "mp3"] },
  mov: { video: ["h264", "hevc", "prores", "mpeg4"], audio: ["aac", "ac3", "mp3", "pcm"] },
  mkv: { video: ["h264", "hevc", "mpeg4", "prores", "vp9"], audio: ["aac", "ac3", "mp3", "opus", "pcm"] },
  f4v: { video: ["h264", "hevc"], audio: ["aac"] },
  ts: { video: ["h264", "hevc", "mpeg4"], audio: ["aac", "ac3", "mp3"] },
  webm: { video: ["vp9", "vp8"], audio: ["opus"] },
  wmv: { video: ["wmv2"], audio: ["wmav2"] },
};

/** Аудиоформаты из «Настройки аудиозаписи» цели. */
const AUDIO_ARGS = {
  mp3: { ext: ".mp3", args: ["-vn", "-c:a", "libmp3lame", "-b:a", "192k"] },
  m4a: { ext: ".m4a", args: ["-vn", "-c:a", "aac", "-b:a", "192k", "-f", "ipod"] },
  wma: { ext: ".wma", args: ["-vn", "-c:a", "wmav2", "-b:a", "192k", "-f", "asf"] },
  aac: { ext: ".aac", args: ["-vn", "-c:a", "aac", "-b:a", "192k", "-f", "adts"] },
  opus: { ext: ".opus", args: ["-vn", "-c:a", "libopus", "-b:a", "128k", "-f", "opus"] },
  flac: { ext: ".flac", args: ["-vn", "-c:a", "flac"] },
  wav: { ext: ".wav", args: ["-vn", "-c:a", "pcm_s16le"] },
};

/** Форматы скриншотов: png/jpg Chromium отдаёт сам, остальное собирает ffmpeg. */
const IMAGE_ARGS = {
  bmp: { ext: ".bmp", args: ["-c:v", "bmp"] },
  tiff: { ext: ".tiff", args: ["-c:v", "tiff"] },
  gif: { ext: ".gif", args: ["-c:v", "gif"] },
};

// ─────────────────────────────────────────────────────────── обновления

const UPDATE_DIR = path.join(app.getPath("temp"), "screen-revesane-update");
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const update = { info: null, downloading: false, file: null, checking: null };

/** Установка из программы: только в собранном приложении и только Windows/macOS. */
function canInstallUpdate() {
  return app.isPackaged && (process.platform === "win32" || process.platform === "darwin");
}

/**
 * Проверить новую версию. manual — пользователь нажал кнопку: тогда
 * пропущенная версия всё равно показывается, а ответ «новых нет» тоже нужен.
 */
async function checkForUpdates(manual = false) {
  if (update.checking) return update.checking;
  update.checking = (async () => {
    const result = await updater.checkLatest({
      fetch: (url, init) => net.fetch(url, init),
      current: app.getVersion(),
    });
    if (!result.ok) {
      log.warn("update", `проверка обновлений не удалась: ${result.error}`);
      return { ...result, canInstall: false };
    }
    const info = { ...result, canInstall: canInstallUpdate() && Boolean(result.asset) };
    if (result.available) {
      log.info("update", `доступна версия ${result.version} (сейчас ${result.current})`);
      update.info = info;
      const skipped = readSettings().skipVersion === result.version;
      if (!skipped || manual) mainWindow?.webContents.send("update:available", info);
    }
    return info;
  })().finally(() => {
    update.checking = null;
  });
  return update.checking;
}

function scheduleUpdateChecks() {
  if (SELFTEST || SELFTEST_MODES || UI_SHOTS) return;
  void updater.cleanDownloads(UPDATE_DIR);
  const run = () => {
    if (readSettings().checkUpdates === false) return;
    void checkForUpdates(false).catch((err) => log.warn("update", `проверка: ${err.message}`));
  };
  // Не в первые секунды: сначала поднимается интерфейс и ffmpeg.
  setTimeout(run, 8000).unref?.();
  setInterval(run, UPDATE_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────── окна

/**
 * Снимки интерфейса в %TEMP% (их переносят в docs/): экран захвата, библиотека,
 * редактор, разметка, разделы настроек, «О программе» и «Помощь».
 *
 * Вынесено из самопроверки, чтобы те же снимки можно было снять отдельно
 * (`--ui-shots`): правки внешнего вида проверяются глазами за 20 секунд,
 * а не за полный прогон с записью экрана.
 */
async function captureUiShots() {
  const shots = {};
  const shoot = async (name) => {
    const img = await mainWindow.webContents.capturePage();
    const target = path.join(app.getPath("temp"), `screen-revesane-${name}.png`);
    await fsp.writeFile(target, img.toPNG());
    return target;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    shots.capture = await shoot("ui");
    // Открытый список режимов: рядом с пунктами видны назначенные клавиши.
    await mainWindow.webContents.executeJavaScript(`document.getElementById('mode-select-btn')?.click(); true`);
    await wait(450);
    shots.modeMenu = await shoot("ui-modemenu");
    await mainWindow.webContents.executeJavaScript(`document.getElementById('mode-menu').hidden = true; true`);
    mainWindow.webContents.send("selftest:view", "library");
    await wait(700);
    shots.library = await shoot("ui-library");
    await mainWindow.webContents.executeJavaScript(
      `document.querySelector('.row-name')?.click(); true`,
    );
    await wait(900);
    shots.editorProbe = await mainWindow.webContents.executeJavaScript(`(() => {
      const v = document.getElementById('editor-video');
      if (!v) return null;
      try { v.currentTime = 0.5; } catch (e) { /* ещё не готов */ }
      return { hasSrc: Boolean(v.src), readyState: v.readyState, width: v.videoWidth, height: v.videoHeight, duration: Number(v.duration) || 0, currentTime: v.currentTime };
    })()`);
    await wait(800);
    shots.editor = await shoot("ui-editor");
    await mainWindow.webContents.executeJavaScript(
      `document.getElementById('editor-close')?.click(); true`,
    );
    await wait(250);
    const openedShot = await mainWindow.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.row-name')];
      const shot = rows.find((r) => /\\.(png|bmp|jpg|jpeg)$/i.test(r.textContent));
      if (shot) shot.click();
      return Boolean(shot);
    })()`);
    await wait(900);
    shots.markup = await shoot("ui-markup");
    shots.markupOpened = openedShot;
    await mainWindow.webContents.executeJavaScript(
      `document.getElementById('editor-close')?.click(); true`,
    );
    await wait(200);
    mainWindow.webContents.send("selftest:view", "settings");
    await wait(500);
    shots.settings = await shoot("ui-settings");
    for (const section of ["general", "output", "audio", "mark", "schedule", "keys"]) {
      await mainWindow.webContents.executeJavaScript(
        `document.querySelector('.snav[data-section="${section}"]')?.click(); true`,
      );
      await wait(320);
      shots[`settings-${section}`] = await shoot(`ui-settings-${section}`);
    }
    for (const view of ["about", "help"]) {
      mainWindow.webContents.send("selftest:view", view);
      await wait(420);
      shots[view] = await shoot(`ui-${view}`);
    }
    mainWindow.webContents.send("selftest:view", "capture");
    await wait(220);
  } catch (err) {
    shots.error = String(err?.message || err);
  }
  return shots;
}

/** Время правки файлов интерфейса — «когда собрана эта копия». */
function rendererBuildTime() {
  let newest = 0;
  for (const file of ["app.js", "index.html", "styles.css"]) {
    try {
      const stat = fs.statSync(path.join(ROOT, "src", "renderer", file));
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      /* файла нет — пропускаем */
    }
  }
  return newest ? new Date(newest).toISOString() : null;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: "#0D1117",
    title: "Screen Revesane",
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(ROOT, "src", "main", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(ROOT, "src", "renderer", "index.html"), {
    query: { lang: resolveLang(readSettings().language) },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  // На Windows это WDA_EXCLUDEFROMCAPTURE: наше окно не попадает в запись,
  // но остаётся видимым на экране.
  try {
    mainWindow.setContentProtection(readSettings().hideSelf !== false);
  } catch {
    /* не поддерживается — не критично */
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    log.error("ui", `страница не загрузилась: ${code} ${description} ${url}`);
    process.stderr.write(`[ui] load failed: ${code} ${description} ${url}\n`);
    if (SELFTEST) {
      process.stdout.write(
        `\nSELFTEST_RESULT ${JSON.stringify({ ok: false, error: `ui load failed: ${description} ${url}` })}\n`,
      );
      setTimeout(() => app.quit(), 200);
    }
  });

  // Ошибки и предупреждения renderer-а попадают в общий лог: без этого
  // причина сбоя в интерфейсе видна только в консоли разработчика.
  mainWindow.webContents.on("console-message", (event, level, message) => {
    const lvl = typeof level === "number" ? level : Number(event?.level ?? 0);
    const text = typeof message === "string" ? message : String(event?.message ?? "");
    if (!text) return;
    if (lvl >= 3) log.error("ui", text);
    else if (lvl === 2) log.warn("ui", text);
  });

  if (SELFTEST_MODES) {
    mainWindow.webContents.on("console-message", (...parts) => {
      const message = typeof parts[2] === "string" ? parts[2] : String(parts[0]?.message ?? "");
      process.stdout.write(`[renderer] ${message}\n`);
    });
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => mainWindow.webContents.send("selftest:modes"), 900);
    });
    setTimeout(() => {
      process.stdout.write(
        `\nMODES_RESULT ${JSON.stringify({ ok: false, error: "timeout: renderer did not report" })}\n`,
      );
      app.quit();
    }, 300_000).unref?.();
  }

  if (UI_SHOTS) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const shots = await captureUiShots();
        process.stdout.write(`\nUI_SHOTS ${JSON.stringify(shots)}\n`);
        setTimeout(() => app.quit(), 200);
      }, 1200);
    });
  }

  if (SELFTEST) {
    mainWindow.webContents.on("console-message", (...parts) => {
      const message = typeof parts[2] === "string" ? parts[2] : String(parts[0]?.message ?? "");
      process.stdout.write(`[renderer] ${message}\n`);
    });
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => mainWindow.webContents.send("selftest:run"), 700);
    });
    // Страховка: если renderer не отчитался, выходим с явной ошибкой, а не висим.
    // Бюджет с запасом: на этой машине каждый захват стартует ~5 с (WGC ждёт
    // первый кадр), а проверок в прогоне больше десятка.
    setTimeout(() => {
      process.stdout.write(
        `\nSELFTEST_RESULT ${JSON.stringify({ ok: false, error: "selftest timeout: renderer did not report" })}\n`,
      );
      app.quit();
    }, 300_000).unref?.();
  }
}

/** Отдельное окно известного размера — цель для теста режима «Окно». */
function createTestTarget() {
  testTargetWindow = new BrowserWindow({
    width: 640,
    height: 480,
    x: 80,
    y: 80,
    title: "SR test target",
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#12241d;color:#6ee7a8;
    font:700 30px 'Segoe UI',sans-serif;display:grid;place-items:center;height:100vh">
    <div style="text-align:center;line-height:1.4">SR test target<br>
    <span style="font-size:16px;color:#9fb3c8">окно 640×480 для проверки захвата</span></div>
    </body></html>`;
  testTargetWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  testTargetWindow.webContents.once("did-finish-load", () => {
    testTargetInfo = testTargetWindow.getContentBounds();
    process.stdout.write(`[test] target bounds ${JSON.stringify(testTargetInfo)}\n`);
  });
  testTargetWindow.on("closed", () => {
    testTargetWindow = null;
  });
}

function setSelfProtection(enabled) {
  for (const win of [mainWindow, panelWindow]) {
    if (!win) continue;
    try {
      win.setContentProtection(Boolean(enabled));
    } catch {
      /* не критично */
    }
  }
}

async function showSources() {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 420, height: 236 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => s.id !== "window:0")
    .map((s) => ({
      id: s.id,
      kind: s.id.startsWith("screen:") ? "screen" : "window",
      name: s.name,
      displayId: s.display_id || null,
      thumbnail: s.thumbnail?.isEmpty() ? null : s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
}

function installDisplayMediaHandler() {
  const ses = session.defaultSession;
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      const audioOnly = capture.audioTarget;
      // Прогрев: захват открывается заранее, пока человек выделяет область,
      // чтобы запись стартовала сразу после подтверждения.
      const prewarm = capture.prewarmTarget;
      if (prewarm) capture.prewarmTarget = null;
      const target = prewarm || capture.target;
      if (!target && !audioOnly) {
        callback({});
        return;
      }
      desktopCapturer
        .getSources({ types: ["screen", "window"] })
        .then((sources) => {
          // Вторая заявка «только звук»: видео берём с экрана (WGC требует
          // источник, иначе loopback не выдаётся), но в запись оно не пойдёт.
          if (audioOnly) {
            capture.audioTarget = null;
            const screens = sources.filter((s) => String(s.id).startsWith("screen:"));
            const byDisplay = audioOnly.displayId
              ? screens.find((s) => String(s.display_id) === String(audioOnly.displayId))
              : null;
            const source = byDisplay ?? screens[0] ?? sources[0];
            // Loopback есть только на Windows; на macOS системный звук —
            // через виртуальное устройство (BlackHole), выбранное источником.
            const wanted = LOOPBACK_SUPPORTED
              ? { video: source, audio: "loopback" }
              : { video: source };
            try {
              callback(wanted);
            } catch {
              callback({ video: source });
            }
            return;
          }

          const source =
            sources.find((s) => s.id === target.sourceId) ?? sources[0];
          const wanted = { video: source };
          // Системный (loopback) звук доступен только для экрана и только
          // на Windows; на macOS — виртуальное устройство источником звука.
          if (target.systemAudio && target.kind === "screen" && LOOPBACK_SUPPORTED) {
            wanted.audio = "loopback";
          }
          try {
            callback(wanted);
          } catch {
            callback({ video: source });
          }
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
}

// ─────────────────────────────────────────────────────────── область

async function pickRegion(intent = "video") {
  if (regionWindow) {
    // Молчаливый отказ здесь выглядел как «нажал — оверлей не появился»:
    // поднимаем уже открытое окно и оставляем след в логе.
    log.warn("region", `выделение области уже открыто (${intent}) — поднимаю существующее окно`);
    try {
      if (!regionWindow.isDestroyed()) {
        regionWindow.setAlwaysOnTop(true, "screen-saver");
        regionWindow.show();
        regionWindow.focus();
      }
    } catch {
      /* окно уже закрывается */
    }
    return { ok: false, reason: "busy" };
  }

  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const bounds = display.bounds;
  log.info(
    "region",
    `оверлей области (${intent}): дисплей ${display.id} ${bounds.width}×${bounds.height} ` +
      `@${display.scaleFactor}x в (${bounds.x}, ${bounds.y}) · курсор (${point.x}, ${point.y})`,
  );

  return new Promise((resolve) => {
    regionResolve = resolve;
    regionWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      // Прозрачному окну нужна именно прозрачная подложка: без неё Electron
      // подкладывает белую, и она «засвечивает» экран под оверлеем — видео
      // внутри рамки выглядело размытым.
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(ROOT, "src", "region", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    regionWindow.setAlwaysOnTop(true, "screen-saver");
    // Windows обрезает новое окно по рабочей области: без явного setBounds
    // оверлей не закрывает панель задач, а замороженный снимок (он во весь
    // экран) сжимается по высоте — выделяешь по картинке, а в кадр попадает
    // соседняя область. Растягиваем окно на весь дисплей.
    try {
      regionWindow.setBounds(bounds);
    } catch (err) {
      log.warn("region", `не удалось растянуть оверлей на весь экран: ${err.message}`);
    }
    // Страховка от «зависшего» оверлея: если окно так и не показалось, оно
    // осталось бы в памяти, и все следующие вызовы получали бы busy — снаружи
    // это выглядит как «выделение области больше не открывается вообще».
    let watch = setTimeout(() => {
      if (!regionWindow) return;
      log.error("region", "оверлей области не показался за 4000 мс — закрываю, выделение снова доступно [SR6001]");
      finish(null, "timeout");
    }, 4000);
    const stopWatch = () => {
      if (!watch) return;
      clearTimeout(watch);
      watch = null;
    };
    // Намерение передаём в оверлей: у записи и снимка разные подписи на кнопке
    // подтверждения, и человек видит, что произойдёт по Enter.
    regionWindow.loadFile(path.join(ROOT, "src", "region", "region.html"), {
      // Размер дисплея нужен оверлею, чтобы положить замороженный снимок
      // пиксель в пиксель: иначе он сжимается по высоте.
      query: {
        intent: intent === "shot" ? "shot" : "video",
        w: String(bounds.width),
        h: String(bounds.height),
        // Текущий формат из настроек: оверлей показывает его в списке, чтобы
        // не выбирать заново каждый раз.
        container: String(readSettings().videoContainer || "auto"),
        // Клавиша, которой рамку можно подтвердить повторно: подписываем ею
        // кнопку и подсказку, вместо жёсткого «Enter».
        hotkey: String(
          (intent === "shot" ? readSettings().hotkeys?.regionShot : readSettings().hotkeys?.region) || "",
        ),
        // Скрыто ли своё окно из захвата: оверлей подскажет, почему приложение
        // не видно под рамкой.
        selfHidden: readSettings().hideSelf !== false ? "1" : "0",
        // Язык интерфейса оверлея — сразу, без ожидания события от main.
        lang: resolveLang(readSettings().language),
      },
    });
    // Битая загрузка иначе оставляла скрытое окно навсегда: выделение области
    // переставало открываться до перезапуска приложения.
    regionWindow.webContents.on("did-fail-load", (_e, code, description, url) => {
      log.error("region", `оверлей области не загрузился: ${code} ${description} ${url} [SR6002]`);
      finish(null, "load-failed");
    });
    // Фоном — замороженный снимок экрана: живое видео под прозрачным окном
    // композитор отдаёт размытым, а со статичным снимком видно ровно то, что
    // попадёт в кадр, и без потери резкости. Снимок готовим параллельно загрузке
    // страницы, а окно показываем только с ним — иначе мелькает прозрачность.
    let backdropImage = null;
    const backdropPromise = desktopCapturer
      .getSources({
        types: ["screen"],
        thumbnailSize: { width: display.bounds.width, height: display.bounds.height },
      })
      .then((sources) => {
        const own =
          sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
        const shot = own?.thumbnail;
        if (!shot || shot.isEmpty()) return null;
        // Держим и nativeImage: из него вырежем заглушку ровно по области,
        // чтобы первые кадры записи совпадали с тем, что человек выделил.
        backdropImage = shot;
        return shot.toDataURL();
      })
      .catch(() => null);

    regionWindow.webContents.once("did-finish-load", async () => {
      const url = await Promise.race([
        backdropPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 700)),
      ]);
      if (!regionWindow) return;
      if (url) regionWindow.webContents.send("region:backdrop", url);
      regionWindow.show();
      regionWindow.focus();
      stopWatch();
      log.info("region", `оверлей показан: замороженная подложка ${url ? "есть" : "нет"}`);
      // Пока человек выделяет рамку, рендерер успевает открыть захват: WGC
      // отдаёт первый кадр через 4–5 с, и эта пауза прячется за выделением.
      // Только для записи: снимку области прогрев не нужен, а открытый захват
      // висел бы зря.
      if (intent === "video") {
        mainWindow?.webContents.send("region:display", {
          displayId: display.id,
          bounds: display.bounds,
          scaleFactor: display.scaleFactor,
        });
      }
    });

    const finish = (rect, failure) => {
      stopWatch();
      const done = regionResolve;
      regionResolve = null;
      regionFinish = null;
      if (regionWindow) {
        const win = regionWindow;
        regionWindow = null;
        try {
          // Сначала прячем, потом уничтожаем: WGC успевает снять кадр с ещё
          // видимым оверлеем, и в снимок области попадало затемнение и рамка
          // (на снимке это выглядело как «размазанная картинка»).
          win.hide();
          win.destroy();
        } catch {
          /* уже закрыто */
        }
      }
      if (!done) return;
      if (!rect) {
        log.info("region", `выделение области не подтверждено: ${failure || "cancelled"}`);
        done({ ok: false, reason: failure || "cancelled" });
        return;
      }
      // Пауза на кадр композитора: за это время экран перерисовывается без
      // оверлея, и захват начинается уже с чистого рабочего стола.
      log.info(
        "region",
        `область подтверждена: ${rect.width}×${rect.height} в (${rect.x}, ${rect.y}), ` +
          `дисплей ${display.id} ${bounds.width}×${bounds.height}`,
      );
      // Заглушка первых кадров: вырезаем выделенную область из снимка экрана,
      // снятого перед показом оверлея. WGC отдаёт живой кадр через 4–5 с,
      // и без заглушки видео начиналось бы с чёрного прямоугольника.
      let placeholder = null;
      try {
        if (backdropImage) {
          const size = backdropImage.getSize();
          const cropRect = {
            x: Math.max(0, Math.min(size.width - 1, Math.round(rect.x))),
            y: Math.max(0, Math.min(size.height - 1, Math.round(rect.y))),
          };
          cropRect.width = Math.max(2, Math.min(size.width - cropRect.x, Math.round(rect.width)));
          cropRect.height = Math.max(2, Math.min(size.height - cropRect.y, Math.round(rect.height)));
          placeholder = backdropImage.crop(cropRect).toDataURL();
        }
      } catch (err) {
        log.warn("region", `заглушка области не сделана: ${err.message}`);
      }
      setTimeout(() => {
        done({
          ok: true,
          // copy — значит «снять и положить в буфер», редактор не открываем.
          copy: Boolean(rect.copy),
          region: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          placeholder,
          // Формат, выбранный в оверлее (только для видео).
          container: rect.container ?? null,
          displayId: display.id,
          displaySize: { width: display.bounds.width, height: display.bounds.height },
          scaleFactor: display.scaleFactor,
        });
      }, OVERLAY_CLEAR_MS);
    };

    regionFinish = finish;

    regionWindow.on("closed", () => {
      stopWatch();
      const done = regionResolve;
      regionResolve = null;
      regionFinish = null;
      regionWindow = null;
      if (done) {
        log.info("region", "окно выделения области закрыто без подтверждения");
        done({ ok: false, reason: "cancelled" });
      }
    });

    if (SELFTEST_MODES) {
      // Сценарий оверлеев для прогона: 1 — перетаскивание, 2 — Esc, 3 — снимок
      // области, 4 — клавиша «выделить и записать видео». Очередь, а не счётчик:
      // шаги теста можно переставлять, не перенумеровывая ветки.
      const step = REGION_SCRIPT[regionAttempts] ?? "drag";
      regionAttempts += 1;
      if (step === "cancel") simulateRegionCancel(regionWindow);
      else simulateRegionDrag(regionWindow);
    }
  });
}

/** Тестовый прогон: второй оверлей закрываем Esc, как это сделал бы человек. */
function simulateRegionCancel(win) {
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      try {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      } catch {
        /* окно уже закрыто */
      }
    }, 500);
  });
}

/** Тестовый прогон оверлея: тянем рамку 130,120 → 520,420 без участия человека. */
/**
 * Тестовый прогон: рисуем рамку, тянем правый нижний угол, переносим крестиком
 * и подтверждаем Enter — так проверяются все три жеста оверлея области.
 */
function simulateRegionDrag(win) {
  const steps = [
    // 1. рамка 130,120 → 520,420
    { type: "mouseDown", x: 130, y: 120 },
    { type: "mouseMove", x: 300, y: 260 },
    { type: "mouseMove", x: 520, y: 420 },
    { type: "mouseUp", x: 520, y: 420 },
    // 2. правый нижний угол: +60/+40 → 450×340
    { type: "mouseDown", x: 520, y: 420 },
    { type: "mouseMove", x: 550, y: 440 },
    { type: "mouseMove", x: 580, y: 460 },
    { type: "mouseUp", x: 580, y: 460 },
    // 3. крестик на верхней линии: переносим рамку на -20/-20
    { type: "mouseDown", x: 355, y: 104 },
    { type: "mouseMove", x: 345, y: 94 },
    { type: "mouseMove", x: 335, y: 84 },
    { type: "mouseUp", x: 335, y: 84 },
    // 4. подтверждение
    { type: "keyDown", keyCode: "Enter" },
    { type: "keyUp", keyCode: "Enter" },
  ];
  win.webContents.once("did-finish-load", () => {
    steps.forEach((step, index) => {
      setTimeout(() => {
        try {
          const payload = step.type === "keyDown" || step.type === "keyUp"
            ? { type: step.type, keyCode: step.keyCode }
            : { ...step, button: "left", clickCount: 1 };
          win.webContents.sendInputEvent(payload);
        } catch {
          /* окно уже закрыто */
        }
      }, 400 + index * 140);
    });
  });
}

// ─────────────────────────────────────────────────────────── ffmpeg

let ffmpegSource = "path"; // откуда взялся ffmpeg: "path" (свой в PATH) или "auto" (скачан)

/** Команда запуска ffmpeg: из PATH или скачанная копия. */
function ffmpegBin() {
  return ffmpegPath || "ffmpeg";
}

/** Команда запуска ffprobe: из PATH или скачанная копия. */
function ffprobeBin() {
  return ffprobePath || "ffprobe";
}

/**
 * События автодоставки ffmpeg: пишем в лог и показываем в интерфейсе.
 * На «ready» ffmpeg уже скачан и проверен — после этого доступны все форматы,
 * и можно повторно попытаться починить .part-файлы, которым ffmpeg не хватало.
 */
function handleFfmpegEvent(event) {
  const summary = {
    start: "своего ffmpeg нет — скачиваю в %APPDATA%\\Screen Revesane\\tools",
    download: `источник: ${event.source}`,
    progress: `загрузка ${Number(event.percent) || 0}%`,
    extract: `распаковка (${event.source})`,
    retry: `${event.source}: не получилось — ${event.error}`,
    ready: `готово (${event.source})`,
    failed: `не удалось: ${event.error}`,
  }[event.phase];
  if (summary) {
    if (event.phase === "failed" || event.phase === "retry") log.warn("ffmpeg", summary);
    else log.info("ffmpeg", summary);
  }
  if (event.phase === "ready") {
    ffmpegPath = event.ffmpegPath;
    ffprobePath = event.ffprobePath;
    ffmpegSource = "auto";
    mainWindow?.webContents.send("ffmpeg:state", { phase: "ready" });
    void recoverPartFiles().catch((err) => log.error("capture", `recoverPartFiles: ${err.message}`));
  } else if (event.phase === "failed") {
    mainWindow?.webContents.send("ffmpeg:state", { phase: "failed", error: event.error });
  } else if (event.phase === "start") {
    mainWindow?.webContents.send("ffmpeg:state", { phase: "start" });
  } else if (event.phase === "progress") {
    mainWindow?.webContents.send("ffmpeg:state", { phase: "progress", percent: event.percent });
  }
}

/**
 * Где искать ffmpeg/ffprobe. GUI-приложения на macOS получают урезанный PATH
 * без /opt/homebrew/bin и /usr/local/bin, поэтому установленный brew ffmpeg
 * нужно проверять по явным путям — имя «ffmpeg» там не найдётся.
 */
const FFMPEG_CANDIDATES = ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
const FFPROBE_CANDIDATES = ["ffprobe", "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"];

/** Первый рабочий кандидат из списка: полный путь или имя (в PATH). */
function probeBinary(candidates, marker) {
  return new Promise((resolve) => {
    let index = 0;
    const tryNext = () => {
      if (index >= candidates.length) {
        resolve(null);
        return;
      }
      const file = candidates[index];
      index += 1;
      let out = "";
      let child;
      try {
        child = spawn(file, ["-hide_banner", "-version"], { windowsHide: true });
      } catch {
        tryNext();
        return;
      }
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => tryNext());
      child.on("close", (code) => {
        if (code === 0 && new RegExp(marker, "i").test(out)) resolve(file);
        else tryNext();
      });
    };
    tryNext();
  });
}

function probeFfmpeg() {
  return probeBinary(FFMPEG_CANDIDATES, "ffmpeg version");
}

function probeFfprobe() {
  return probeBinary(FFPROBE_CANDIDATES, "ffprobe version");
}

function convertToMp4(webmPath) {
  return new Promise((resolve, reject) => {
    const mp4Path = webmPath.replace(/\.webm$/i, ".mp4");
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", webmPath,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
      mp4Path,
    ];
    const child = spawn(ffmpegBin(), args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve(mp4Path);
      else reject(new Error(stderr.trim() || `ffmpeg exited ${code}`));
    });
  });
}

/** Общие параметры звука из настроек: битрейт, частота, каналы. */
function audioTailArgs(settings) {
  const out = ["-c:a", "aac", "-b:a", `${Number(settings.audioQuality) || 192}k`];
  if (Number(settings.sampleRate)) out.push("-ar", String(settings.sampleRate));
  if (Number(settings.channels)) out.push("-ac", String(settings.channels));
  return out;
}

/** Подбирает кодек под контейнер и говорит, если пришлось заменить выбор. */
function resolveCodecs(target, settings) {
  const allowed = CONTAINER_CODECS[target];
  if (!allowed) return null;
  const wantedVideo = String(settings.videoCodec || "auto").toLowerCase();
  const wantedAudio = String(settings.audioCodec || "auto").toLowerCase();
  const videoKey = allowed.video.includes(wantedVideo) ? wantedVideo : allowed.video[0];
  const audioKey = allowed.audio.includes(wantedAudio) ? wantedAudio : allowed.audio[0];
  const replaced =
    (wantedVideo !== "auto" && videoKey !== wantedVideo) ||
    (wantedAudio !== "auto" && audioKey !== wantedAudio);
  return {
    videoKey,
    audioKey,
    note: replaced
      ? I18N.t(
          "кодеки подогнаны под {0}: {1} + {2}",
          target.toUpperCase(),
          I18N.t(VIDEO_CODECS[videoKey].label),
          I18N.t(AUDIO_CODECS[audioKey].label),
        )
      : null,
  };
}

/** Контейнер по умолчанию для явно выбранного кодека (когда контейнер «как у Chromium»). */
function containerForCodec(codec) {
  return {
    h264: "mp4",
    hevc: "mp4",
    mpeg4: "mkv",
    prores: "mov",
    vp9: "webm",
    vp8: "webm",
    wmv2: "wmv",
  }[codec] ?? "mp4";
}

/** Перекод/ремукс в выбранный контейнер (auto → без перекода). */
function convertContainer(sourcePath, container, options = {}) {
  const raw = String(container || "auto").toLowerCase();
  if (!raw || raw === "auto") return Promise.resolve({ path: sourcePath, converted: false });
  const target = raw === "mpegts" ? "ts" : raw;
  const ext = CONTAINER_EXT[target] ?? `.${target}`;
  const force = Boolean(options.force);
  if (!force && sourcePath.toLowerCase().endsWith(ext)) {
    return Promise.resolve({ path: sourcePath, converted: false });
  }
  if (!ffmpegPath) {
    return Promise.resolve({ path: sourcePath, converted: false, note: I18N.t("ffmpeg нет — оставлен {0}", path.extname(sourcePath)) });
  }

  let outPath = sourcePath.replace(/\.[^.]+$/, "") + ext;
  // Если форсим перекод при совпадающем контейнере, нельзя писать поверх входного файла.
  const replaceInPlace = outPath.toLowerCase() === sourcePath.toLowerCase();
  if (replaceInPlace) outPath = sourcePath.replace(/\.[^.]+$/, "") + `_conv${ext}`;

  const base = ["-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath];
  if (target !== "gif" && !CONTAINER_ARGS[target]) {
    return Promise.resolve({ path: sourcePath, converted: false, note: I18N.t("контейнер {0} не поддержан", raw) });
  }

  const settings = readSettings();
  const extra = [];
  const resolved = CONTAINER_CODECS[target] ? resolveCodecs(target, settings) : null;

  if (resolved) {
    extra.push(...VIDEO_CODECS[resolved.videoKey].args);
    const bitrate = `${Number(settings.audioQuality) || 192}k`;
    extra.push(...AUDIO_CODECS[resolved.audioKey].args(bitrate));
    if (Number(settings.sampleRate)) extra.push("-ar", String(settings.sampleRate));
    if (Number(settings.channels)) extra.push("-ac", String(settings.channels));
    const fps = Number(settings.fps) || 30;
    const keySec = Number(settings.keyframeSec) || 1;
    extra.push("-g", String(Math.max(1, Math.round(fps * keySec))));
  }

  const muxerArgs = { wmv: ["-f", "asf"], ts: ["-f", "mpegts"], f4v: ["-f", "mp4"] }[target] ?? [];
  const faststart = ["mp4", "mov", "f4v"].includes(target) ? ["-movflags", "+faststart"] : [];

  // Водяной знак: текст идёт одним -vf, картинка требует второго входа и
  // filter_complex. На GIF не накладываем — там своя палитра и цикл.
  const wmPlan = options.watermark && target !== "gif" ? options.watermark : null;
  const wmExtraInputs = wmPlan?.mode === "image" ? wmPlan.extraInputs : [];
  const wmMaps = wmPlan?.mode === "image" ? wmPlan.maps : [];
  const wmVf = wmPlan?.mode === "text" ? ["-vf", wmPlan.videoFilter] : [];
  const wmComplex = wmPlan?.mode === "image" ? ["-filter_complex", wmPlan.filterComplex] : [];
  const codecArgs = resolved ? extra : CONTAINER_ARGS[target] ?? [];

  const args =
    target === "gif"
      ? [...base, "-vf", "fps=15,scale=iw:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0", outPath]
      : [
          ...base,
          ...wmExtraInputs,
          ...muxerArgs,
          ...codecArgs,
          ...wmComplex,
          ...wmMaps,
          ...wmVf,
          ...faststart,
          outPath,
        ];

  return new Promise((resolve) => {
    const child = spawn(ffmpegBin(), args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    child.on("error", (err) => resolve({ path: sourcePath, converted: false, note: `ffmpeg: ${err.message}` }));
    child.on("close", async (code) => {
      await watermark.cleanup(wmPlan);
      if (code !== 0) {
        if (replaceInPlace) await fsp.unlink(outPath).catch(() => {});
        log.error("ffmpeg", `перекод в ${raw.toUpperCase()} не удался: ${String(stderr).trim().slice(0, 300)}`);
        return resolve({ path: sourcePath, converted: false, note: I18N.t("перекод в {0} не удался", raw.toUpperCase()) });
      }
      if (replaceInPlace) {
        try {
          await fsp.unlink(sourcePath);
          await fsp.rename(outPath, sourcePath);
          outPath = sourcePath;
        } catch (err) {
          return resolve({ path: sourcePath, converted: false, note: I18N.t("не удалось заменить файл: {0}", err.message) });
        }
      }
      resolve({ path: outPath, converted: true });
    });
  });
}

/** Аудио-дорожка → MP3/M4A/WMA/AAC/OPUS/FLAC/WAV. */
async function convertAudio(sourcePath, format) {
  const key = String(format || "mp3").toLowerCase();
  const spec = AUDIO_ARGS[key];
  if (!spec) return { path: sourcePath, converted: false, note: I18N.t("аудиоформат {0} не поддержан", format) };
  if (!ffmpegPath) return { path: sourcePath, converted: false, note: I18N.t("ffmpeg нет — сохранён исходный контейнер") };

  const settings = readSettings();
  const codec = {
    mp3: ["-c:a", "libmp3lame"],
    m4a: ["-c:a", "aac", "-f", "ipod"],
    wma: ["-c:a", "wmav2", "-f", "asf"],
    aac: ["-c:a", "aac", "-f", "adts"],
    opus: ["-c:a", "libopus", "-f", "opus"],
    flac: ["-c:a", "flac"],
    wav: ["-c:a", "pcm_s16le"],
  }[key];

  const args = ["-i", sourcePath, "-vn", ...codec];
  if (!["flac", "wav"].includes(key)) {
    args.push("-b:a", `${Number(settings.audioQuality) || 192}k`);
  }
  if (Number(settings.sampleRate)) args.push("-ar", String(settings.sampleRate));
  if (Number(settings.channels)) args.push("-ac", String(settings.channels));

  const outPath = sourcePath.replace(/\.[^.]+$/, "") + spec.ext;
  const run = await runFfmpeg([...args, outPath]);
  if (!run.ok) return { path: sourcePath, converted: false, note: run.error };
  return { path: outPath, converted: true };
}

/** Картинка целиком в data URL — чтобы canvas не «портился» file://-источником. */
async function readImageAsDataUrl(filePath) {
  if (!filePath) return { ok: false, reason: "no-file" };
  try {
    const st = await fsp.stat(filePath);
    if (st.size > 120 * 1024 * 1024) return { ok: false, reason: "too-large" };
    const buffer = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".bmp" ? "image/bmp"
        : ext === ".gif" ? "image/gif"
          : ext === ".tiff" || ext === ".tif" ? "image/tiff"
            : "image/png";
    return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString("base64")}`, size: st.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Сохранение размеченной копии скриншота рядом с оригиналом. */
async function saveAnnotated(payload) {
  const dataUrl = payload?.dataUrl;
  if (!dataUrl) return { ok: false, reason: "no-image" };
  const format = String(payload?.format || "png").toLowerCase();
  const ext = format === "jpg" || format === "jpeg" ? ".jpg" : ".png";
  const dir = shotsDir();
  await fsp.mkdir(dir, { recursive: true });

  const base = String(payload?.baseName || "shot").replace(/\.[^.]+$/, "");
  const stamp = stampName("").replace("ScreenRevesane_", "");
  const outPath = await uniquePath(path.join(dir, `${base}_markup_${stamp}${ext}`));
  const base64 = String(dataUrl).replace(/^data:image\/[a-z+]+;base64,/, "");
  await fsp.writeFile(outPath, Buffer.from(base64, "base64"));
  return { ok: true, path: outPath, size: (await fsp.stat(outPath)).size };
}

/** Метаданные файла через ffprobe (нужны для склейки и смены скорости). */
function probeMedia(filePath) {
  return new Promise((resolve) => {
    if (!ffprobePath) return resolve(null);
    const child = spawn(
      ffprobeBin(),
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath],
      { windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(out);
        const video = (parsed.streams ?? []).find((s) => s.codec_type === "video");
        const audio = (parsed.streams ?? []).find((s) => s.codec_type === "audio");
        resolve({
          width: Number(video?.width) || 0,
          height: Number(video?.height) || 0,
          hasAudio: Boolean(audio),
          duration: Number(parsed.format?.duration) || 0,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/** Склейка нескольких записей в один файл. */
async function mergeMedia({ paths }) {
  if (!Array.isArray(paths) || paths.length < 2) return { ok: false, reason: "need-two" };
  if (!ffmpegPath) return { ok: false, reason: "no-ffmpeg" };
  for (const item of paths) {
    try {
      await fsp.access(item);
    } catch {
      return { ok: false, reason: "missing-file", error: item };
    }
  }

  const probes = [];
  for (const item of paths) probes.push(await probeMedia(item));
  const width = probes[0]?.width || 1920;
  const height = probes[0]?.height || 1080;
  const allAudio = probes.every((p) => p?.hasAudio);
  const settings = readSettings();

  const args = [];
  for (const item of paths) args.push("-i", item);

  const filters = [];
  paths.forEach((_, index) => {
    filters.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`,
    );
    if (allAudio) filters.push(`[${index}:a]aresample=48000,aformat=channel_layouts=stereo[a${index}]`);
  });
  const inputs = paths.map((_, index) => (allAudio ? `[v${index}][a${index}]` : `[v${index}]`)).join("");
  filters.push(`${inputs}concat=n=${paths.length}:v=1:a=${allAudio ? 1 : 0}[outv]${allAudio ? "[outa]" : ""}`);

  const outPath = await uniquePath(path.join(path.dirname(paths[0]), `${stampName("")}_merged.mp4`));
  const maps = allAudio ? ["-map", "[outv]", "-map", "[outa]"] : ["-map", "[outv]"];
  const fps = Number(settings.fps) || 30;
  const keySec = Number(settings.keyframeSec) || 1;
  const full = [
    ...args,
    "-filter_complex", filters.join(";"),
    ...maps,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-g", String(Math.max(1, Math.round(fps * keySec))),
    ...(allAudio ? audioTailArgs(settings) : []),
    "-movflags", "+faststart",
    outPath,
  ];

  const run = await runFfmpeg(full);
  if (!run.ok) return { ok: false, reason: "ffmpeg", error: run.error };
  const st = await fsp.stat(outPath).catch(() => null);
  return { ok: true, path: outPath, size: st?.size ?? 0, merged: paths.length, audio: allAudio };
}

/** Смена скорости без рассинхрона звука. */
async function speedMedia({ filePath, speed }) {
  if (!filePath) return { ok: false, reason: "no-file" };
  if (!ffmpegPath) return { ok: false, reason: "no-ffmpeg" };
  const factor = Math.min(4, Math.max(0.25, Number(speed) || 1));
  if (factor === 1) return { ok: false, reason: "same-speed" };

  const probe = await probeMedia(filePath);
  const hasAudio = probe?.hasAudio ?? true;
  const tempo = factor > 2 ? "2.0,2.0" : factor < 0.5 ? "0.5,0.5" : String(factor);

  const ext = path.extname(filePath) || ".mp4";
  const outPath = await uniquePath(filePath.replace(/\.[^.]+$/, "") + `_x${String(factor).replace(".", "_")}${ext}`);

  const settings = readSettings();
  const filters = hasAudio
    ? `[0:v]setpts=PTS/${factor}[v];[0:a]atempo=${tempo}[a]`
    : `[0:v]setpts=PTS/${factor}[v]`;
  const maps = hasAudio ? ["-map", "[v]", "-map", "[a]"] : ["-map", "[v]"];

  const args = [
    "-i", filePath,
    "-filter_complex", filters,
    ...maps,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...(hasAudio ? audioTailArgs(settings) : []),
    "-movflags", "+faststart",
    outPath,
  ];

  const run = await runFfmpeg(args);
  if (!run.ok) return { ok: false, reason: "ffmpeg", error: run.error };
  const st = await fsp.stat(outPath).catch(() => null);
  return {
    ok: true,
    path: outPath,
    size: st?.size ?? 0,
    speed: factor,
    durationBefore: probe?.duration ?? 0,
  };
}

// ─────────────────────────────────────────────── обрезка и кадры

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("close", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `ffmpeg exited ${code}` }),
    );
  });
}

/**
 * То же, но с прогрессом: ffmpeg пишет в stdout пары key=value с текущим
 * временем готового потока. Нужно для долгих операций (сборка прокси).
 */
function runFfmpegProgress(args, onTick) {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegBin(),
      [
        "-hide_banner", "-loglevel", "error", "-nostats",
        "-progress", "pipe:1", "-stats_period", "0.2",
        "-y", ...args,
      ],
      { windowsHide: true },
    );
    let stderr = "";
    let buffer = "";
    let lastTick = 0;
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const matched = /^out_time_us=(\d+)/.exec(line.trim());
        if (!matched) continue;
        const outSec = Number(matched[1]) / 1e6;
        if (!Number.isFinite(outSec)) continue;
        const now = Date.now();
        // Не чаще пяти событий в секунду: рендереру больше не нужно.
        if (now - lastTick < 200) continue;
        lastTick = now;
        try {
          onTick?.(outSec);
        } catch {
          /* обработчик не должен ронять конвейер */
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("close", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `ffmpeg exited ${code}` }),
    );
  });
}

async function trimMedia({ filePath, startSec, endSec, accurate = true }) {
  if (!filePath) return { ok: false, reason: "no-file" };
  if (!ffmpegPath) return { ok: false, reason: "no-ffmpeg" };
  const start = Math.max(0, Number(startSec) || 0);
  const end = Math.max(start + 0.2, Number(endSec) || 0);
  const ext = path.extname(filePath) || ".mp4";
  const base = path.basename(filePath, ext);
  const stamp = `${start.toFixed(2)}-${end.toFixed(2)}`.replace(/\./g, "s");
  const outPath = await uniquePath(path.join(path.dirname(filePath), `${base}_trim_${stamp}${ext}`));
  const common = ["-ss", String(start), "-to", String(end), "-i", filePath];
  const args = accurate
    ? [...common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outPath]
    : [...common, "-c", "copy", outPath];
  const run = await runFfmpeg(args);
  if (!run.ok) return { ok: false, reason: "ffmpeg", error: run.error };
  const st = await fsp.stat(outPath).catch(() => null);
  return { ok: true, path: outPath, size: st?.size ?? 0, accurate, durationSec: end - start };
}

async function snapshotFromVideo({ filePath, atSec }) {
  if (!ffmpegPath) return { ok: false, reason: "no-ffmpeg" };
  if (!filePath) return { ok: false, reason: "no-file" };
  const dir = shotsDir();
  await fsp.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, stampName(".png"));
  const run = await runFfmpeg([
    "-ss", String(Math.max(0, Number(atSec) || 0)),
    "-i", filePath,
    "-frames:v", "1",
    outPath,
  ]);
  if (!run.ok) return { ok: false, reason: "ffmpeg", error: run.error };
  const st = await fsp.stat(outPath).catch(() => null);
  return { ok: true, path: outPath, size: st?.size ?? 0 };
}

async function deleteMedia({ filePath }) {
  if (!filePath) return { ok: false, reason: "no-file" };
  try {
    await shell.trashItem(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function sendPreviewProgress(payload) {
  try {
    mainWindow?.webContents.send("preview:progress", payload);
  } catch {
    /* окно уже закрыто */
  }
}

/**
 * Chromium играет MP4/WebM, но не H.264 внутри MKV и не GIF в <video>.
 * Для таких файлов собираем лёгкий прокси в temp, чтобы редактор всё же
 * показывал картинку; обрезка при этом всегда идёт по оригиналу.
 * Ход сборки уходит в окно событиями preview:progress: на длинной записи
 * перекод занимает заметное время и не должен выглядеть зависанием.
 */
async function makePreview(filePath, options = {}) {
  if (!filePath) return fail("SR3001", { reason: "no-file" });
  const ext = path.extname(filePath).toLowerCase();
  const playable = [".mp4", ".webm", ".mov"].includes(ext);
  if (playable) return { ok: true, url: pathToFileURL(filePath).href, direct: true };
  if (!ffmpegPath) {
    log.warn("preview", `прокси недоступен: нет ffmpeg, отдаю файл как есть [SR5001]`);
    return { ok: true, url: pathToFileURL(filePath).href, direct: true, note: I18N.t("прокси недоступен: нет ffmpeg") };
  }

  const previewDir = path.join(app.getPath("temp"), "screen-revesane-preview");
  await fsp.mkdir(previewDir, { recursive: true });
  const st = await fsp.stat(filePath).catch(() => null);
  if (!st) return fail("SR3001", { reason: "not-found" });
  const key = `${path.basename(filePath, ext)}-${st.size}-${Math.round(st.mtimeMs)}`.replace(/[^\w.-]+/g, "_");
  const outPath = path.join(previewDir, `${key}.mp4`);
  // Пишем в отдельный файл и переименовываем только после успеха: недоделанный
  // прокси не должен попасть в кэш как готовый. Расширение .mp4 обязано остаться
  // в конце имени — иначе ffmpeg не может выбрать муксер по имени файла.
  const partPath = path.join(previewDir, `${key}.part.mp4`);
  const note = I18N.t("предпросмотр в пониженном качестве");

  let ready = false;
  // force — пересобрать прокси заново. Нужен самопроверке (иначе готовый кэш
  // даёт единственное событие «done» и проверка прогресса ложно падает) и
  // пригодится, если кэш побился.
  if (!options.force) {
    try {
      ready = (await fsp.stat(outPath)).size > 1024;
    } catch {
      ready = false;
    }
  }
  if (ready) {
    sendPreviewProgress({ filePath, phase: "done", percent: 100, cached: true, note });
    return { ok: true, url: pathToFileURL(outPath).href, direct: false, note, cached: true };
  }

  sendPreviewProgress({ filePath, phase: "probe", percent: 0, message: I18N.t("читаю длительность записи") });
  const probe = await probeMedia(filePath);
  const durationSec = Number(probe?.duration) || 0;

  await fsp.rm(partPath, { force: true }).catch(() => {});
  sendPreviewProgress({
    filePath,
    phase: "encode",
    percent: 0,
    durationSec,
    message: I18N.t("перекодирую в H.264 для проигрывания"),
  });
  const run = await runFfmpegProgress(
    [
      "-i", filePath,
      "-vf", "scale='min(1280,iw)':-2",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart",
      partPath,
    ],
    (outSec) => {
      const percent = durationSec > 0
        ? Math.min(99, Math.max(0, Math.round((outSec / durationSec) * 100)))
        : 0;
      sendPreviewProgress({ filePath, phase: "encode", percent, outSec, durationSec });
    },
  );
  if (!run.ok) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    sendPreviewProgress({ filePath, phase: "error", percent: 0, error: run.error });
    log.error("preview", `прокси не собрался для ${path.basename(filePath)}: ${String(run.error).slice(0, 300)} [SR3001]`);
    return fail("SR3001", { error: run.error });
  }
  await fsp.rm(outPath, { force: true }).catch(() => {});
  try {
    await fsp.rename(partPath, outPath);
  } catch (err) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    sendPreviewProgress({ filePath, phase: "error", percent: 0, error: err.message });
    log.error("preview", `не удалось переименовать прокси ${path.basename(partPath)}: ${err.message} [SR3001]`);
    return fail("SR3001", { error: err.message });
  }
  sendPreviewProgress({ filePath, phase: "done", percent: 100, durationSec, note });
  log.info("preview", `прокси готов: ${path.basename(outPath)} (${durationSec ? `${Math.round(durationSec)} с` : "длительность неизвестна"})`);
  return { ok: true, url: pathToFileURL(outPath).href, direct: false, note };
}

// ─────────────────────────────────────────────────────────── запись

function stampName(ext) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  // Миллисекунды в имени: две записи подряд не перезапишут друг друга.
  return `ScreenRevesane_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}${ext}`;
}

/** Не перезаписывать существующие файлы: добавляет _2, _3 … */
async function uniquePath(candidate) {
  const exists = async (target) => {
    try {
      await fsp.access(target);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await exists(candidate))) return candidate;
  const ext = path.extname(candidate);
  const base = candidate.slice(0, candidate.length - ext.length);
  for (let index = 2; index < 1000; index += 1) {
    const next = `${base}_${index}${ext}`;
    if (!(await exists(next))) return next;
  }
  return candidate;
}

function displayForTarget(target) {
  if (!target) return null;
  const displays = screen.getAllDisplays();
  if (target.displayId) {
    const byId = displays.find((d) => String(d.id) === String(target.displayId));
    if (byId) return byId;
  }
  return screen.getPrimaryDisplay();
}

async function startCapture(payload) {
  if (capture.active) return fail("SR1003", { reason: "already-recording" });

  const target = payload?.target;
  if (!target?.sourceId) return fail("SR1002", { reason: "no-source" });

  const settings = readSettings();
  const dir = outputDir();
  await fsp.mkdir(dir, { recursive: true });

  const ext = payload.ext === ".mp4" ? ".mp4" : ".webm";
  const filePath = await uniquePath(path.join(dir, stampName(ext)));
  // Пишем в <имя>.part.<ext>: недописанная запись не выглядит готовым файлом,
  // а при падении процесса её можно попробовать починить (см. recoverPartFiles).
  const partPath = filePath.replace(/(\.[^.]+)$/, ".part$1");

  capture.target = target;
  capture.filePath = filePath;
  capture.partPath = partPath;
  capture.ext = ext;
  capture.audio = Boolean(payload.audio);
  capture.selfVisible = Boolean(payload.selfVisible);
  // Защита от захвата выставляется явно под цель записи: перечисление
  // источников могло оставить свои окна «открытыми», а запись своего окна —
  // наоборот, требует их снять. Иначе после списка оставался гонный статус.
  if (capture.selfVisible) setSelfProtection(false);
  else setSelfProtection(readSettings().hideSelf !== false);
  try {
    capture.stream = fs.createWriteStream(partPath);
  } catch (err) {
    log.error("capture", `не открылся поток записи ${partPath}: ${err.message} [SR1001]`);
    return fail("SR1001", { reason: "write-stream", error: err.message });
  }
  capture.stream.on("error", (err) => {
    log.error("capture", `ошибка записи в ${partPath}: ${err.message} [SR1001]`);
  });
  capture.active = true;
  capture.startedAt = Date.now();
  log.info(
    "capture",
    `старт: ${target.kind || "?"} → ${path.basename(filePath)} (${ext}, звук: ${Boolean(payload.audio)})`,
  );

  // Авто-остановка: «Автоматическая остановка» на главной панели.
  // Отсчёт стартует не здесь, а с первого записанного чанка (см. capture:chunk):
  // старт MediaRecorder на медленной машине занимает секунды, и таймер,
  // взведённый заранее, успевал сработать до того, как запись станет активной.
  clearTimeout(capture.autostopTimer);
  capture.autostopTimer = null;
  const minutes = Number(settings.autostopMin) || 0;
  capture.autostopMin = minutes;
  capture.autostopArmedAt = 0;

  // Поток позиции курсора для подсветки в кадре.
  clearInterval(capture.cursorTimer);
  capture.cursorTimer = setInterval(() => {
    if (!capture.active) return;
    const live = readSettings();
    if (!live.cursorHighlight) return;
    const point = screen.getCursorScreenPoint();
    mainWindow?.webContents.send("cursor:point", point);
  }, 40);

  if (settings.showPanel) showPanel(settings.panelStyle);

  const display = displayForTarget(target);
  // Заглушка для первых кадров: WGC отдаёт живой кадр через 4–5 с, и без неё
  // запись начиналась бы с чёрного экрана. Снимок берём заранее, параллельно
  // всё равно нужно ждать захват.
  let placeholder = null;
  // Для области заглушка уже есть — её вырезал оверлей, и лишний вызов
  // desktopCapturer только отодвигал старт записи на полсекунды.
  if (payload.needPlaceholder !== false) {
    try {
      const thumbSize = target.kind === "screen" && display
        ? { width: display.bounds.width, height: display.bounds.height }
        : { width: 1280, height: 720 };
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: thumbSize,
      });
      const own = sources.find((s) => s.id === target.sourceId);
      if (own && !own.thumbnail.isEmpty()) placeholder = own.thumbnail.toDataURL();
    } catch {
      /* без заглушки: первые кадры будут чёрными */
    }
  }

  return {
    ok: true,
    filePath,
    ext,
    placeholder,
    display: display
      ? {
          bounds: display.bounds,
          scaleFactor: display.scaleFactor,
          id: display.id,
        }
      : null,
    autostopMin: minutes,
  };
}

function chunkToBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return null;
}

/**
 * Взводит авто-остановку по первому записанному чанку — один раз за запись.
 * Так отсчёт идёт от реального начала записи, а не от выдачи разрешения на
 * захват: между этими моментами на медленной машине проходит до 10 секунд.
 */
function armAutostop() {
  if (!capture.active) return;
  const minutes = Number(capture.autostopMin) || 0;
  if (minutes <= 0) return;
  if (capture.autostopArmedAt) return;
  capture.autostopArmedAt = Date.now();
  clearTimeout(capture.autostopTimer);
  capture.autostopTimer = setTimeout(() => {
    capture.autostopTimer = null;
    mainWindow?.webContents.send("record:command", "stop");
  }, Math.max(5_000, minutes * 60_000));
}

async function finishCapture(payload = {}) {
  if (!capture.active) return fail("SR1004", { reason: "not-recording" });

  const filePath = capture.filePath;
  const partPath = capture.partPath;
  const ext = capture.ext;
  const startedAt = capture.startedAt;
  const ws = capture.stream;
  const wasAudio = Boolean(capture.audio);
  const wasSelfVisible = Boolean(capture.selfVisible);

  capture.active = false;
  capture.target = null;
  capture.stream = null;
  capture.filePath = null;
  capture.partPath = null;
  capture.audio = false;
  capture.selfVisible = false;
  if (wasSelfVisible) setSelfProtection(readSettings().hideSelf !== false);
  clearTimeout(capture.autostopTimer);
  capture.autostopTimer = null;
  capture.autostopArmedAt = 0;
  clearInterval(capture.cursorTimer);
  hidePanel();
  hideRecordingFrame();

  await new Promise((resolve) => {
    if (!ws) return resolve();
    ws.end(resolve);
  });

  // Снимаем суффикс .part только когда поток закрыт: до этого файл считается
  // недописанным. Если переименовать не вышло — работаем с .part как с файлом,
  // чтобы запись не пропала из-за прав на папку.
  let sourcePath = filePath;
  if (partPath && partPath !== filePath) {
    try {
      await fsp.rename(partPath, filePath);
    } catch (err) {
      sourcePath = partPath;
      log.warn("capture", `не удалось переименовать ${path.basename(partPath)}: ${err.message} [SR2003]`);
    }
  }

  const settings = readSettings();
  const wanted = String(settings.videoContainer || "auto").toLowerCase();
  const codecWanted = String(settings.videoCodec || "auto").toLowerCase();
  // Явный кодек требует перекода, даже если контейнер совпал с родным для Chromium.
  const targetContainer = wanted === "auto"
    ? (codecWanted !== "auto" ? containerForCodec(codecWanted) : "auto")
    : wanted;
  let finalPath = sourcePath;
  let converted = false;
  let note = null;
  let failCode = null;

  // Водяной знак можно только впечатать в кадр — значит, нужен перекод,
  // даже когда контейнер «как у Chromium» и без знака перекода бы не было.
  const wmSettings = watermark.fromSettings(settings);
  let wmPlan = null;
  if (watermark.isActive(wmSettings)) {
    if (wasAudio) {
      note = I18N.t("водяной знак не накладывается на аудиозапись");
    } else {
      wmPlan = watermark.plan(wmSettings);
      if (wmPlan?.error) {
        note = I18N.t("водяной знак не наложен: {0}", wmPlan.error);
        failCode = "SR2002";
        log.warn("watermark", `${note} [SR2002]`);
        wmPlan = null;
      }
    }
  }

  if (wasAudio) {
    const result = await convertAudio(sourcePath, settings.audioFormat);
    finalPath = result.path;
    converted = result.converted;
    note = result.note ?? note;
    if (converted && finalPath !== sourcePath) await fsp.unlink(sourcePath).catch(() => {});
  } else if (wmPlan) {
    // Со знаком всегда перекодируем: цель — тот контейнер, что выбран (или MP4 по умолчанию).
    const wmTarget = targetContainer === "auto" ? "mp4" : targetContainer;
    const result = await convertContainer(sourcePath, wmTarget, {
      force: true,
      watermark: wmPlan,
    });
    finalPath = result.path;
    converted = result.converted;
    note = result.note ?? null;
    // Проверяем только `converted`: при совпадении контейнера ffmpeg пишет
    // `<имя>_conv.mp4` и подменяет им исходник, поэтому путь остаётся прежним,
    // а знак при этом уже в кадре.
    if (!converted) {
      failCode = "SR2002";
      note = note || I18N.t("водяной знак не наложен: перекод не удался");
      log.error("watermark", `${note} [SR2002]`);
    } else {
      if (finalPath !== sourcePath) await fsp.unlink(sourcePath).catch(() => {});
      log.info("watermark", `наложен (${wmPlan.mode}), контейнер ${wmTarget.toUpperCase()}`);
    }
  } else if (targetContainer === "auto") {
    if (ext === ".webm" && ffmpegPath) {
      try {
        finalPath = await convertToMp4(sourcePath);
        converted = true;
        await fsp.unlink(sourcePath).catch(() => {});
      } catch (err) {
        note = I18N.t("перекод в MP4 не удался: {0}", err.message);
        failCode = "SR2002";
        log.error("capture", `${note} [SR2002]`);
      }
    } else if (ext === ".webm") {
      note = I18N.t("ffmpeg не найден — сохранён WebM");
      failCode = "SR5001";
    }
  } else {
    const result = await convertContainer(sourcePath, targetContainer, { force: codecWanted !== "auto" });
    finalPath = result.path;
    converted = result.converted;
    note = result.note ?? null;
    if (result.ok === false) failCode = /ffmpeg/i.test(String(result.note || "")) ? "SR5001" : "SR2002";
    if (converted && finalPath !== sourcePath) await fsp.unlink(sourcePath).catch(() => {});
  }

  let size = 0;
  try {
    size = (await fsp.stat(finalPath)).size;
  } catch {
    /* файла нет — вернём 0 */
  }

  // Проверка «файл короче сессии»: раньше последний чанк записи терялся, и
  // сессия на 16 с превращалась в файл на 11 с — по логу это было незаметно.
  // Теперь расхождение видно сразу, с кодом SR2004.
  const recordedMs = Number(payload.recordedMs) || Date.now() - startedAt;
  if (!wasAudio && recordedMs > 3000) {
    const probed = await probeMedia(finalPath);
    const fileMs = Math.round((Number(probed?.duration) || 0) * 1000);
    const lostMs = recordedMs - fileMs;
    if (fileMs > 0 && lostMs > Math.max(1500, recordedMs * 0.12)) {
      log.warn(
        "capture",
        `файл короче записи на ${(lostMs / 1000).toFixed(1)} с: сессия ${recordedMs} мс, ` +
          `в файле ${fileMs} мс [SR2004]`,
      );
      note = note ? I18N.t("{0} · файл короче сессии", note) : I18N.t("файл короче сессии");
    }
  }

  // Пустой файл — не результат: убираем и говорим об этом прямо.
  if (size === 0) {
    await fsp.unlink(finalPath).catch(() => {});
    log.error("capture", `пустой файл записи удалён (длительность ${Date.now() - startedAt} мс) [SR2001]`);
    return fail("SR2001", { reason: "empty-recording", durationMs: Date.now() - startedAt });
  }

  log.info(
    "capture",
    `стоп: ${path.basename(finalPath)} · ${size} Б · ${Date.now() - startedAt} мс · перекод ${converted}${note ? ` · ${note}` : ""}`,
  );

  return {
    ok: true,
    path: finalPath,
    size,
    converted,
    note,
    code: failCode,
    durationMs: Date.now() - startedAt,
  };
}

async function abortCapture() {
  if (!capture.active) return { ok: false };
  const filePath = capture.filePath;
  const partPath = capture.partPath;
  const ws = capture.stream;
  const wasSelfVisible = Boolean(capture.selfVisible);
  capture.active = false;
  capture.target = null;
  capture.stream = null;
  capture.filePath = null;
  capture.partPath = null;
  capture.audio = false;
  capture.selfVisible = false;
  if (wasSelfVisible) setSelfProtection(readSettings().hideSelf !== false);
  clearTimeout(capture.autostopTimer);
  capture.autostopTimer = null;
  capture.autostopArmedAt = 0;
  clearInterval(capture.cursorTimer);
  hidePanel();
  hideRecordingFrame();
  await new Promise((resolve) => (ws ? ws.end(resolve) : resolve()));
  if (partPath) await fsp.unlink(partPath).catch(() => {});
  if (filePath) await fsp.unlink(filePath).catch(() => {});
  log.warn("capture", `запись отменена, файл удалён: ${path.basename(filePath || "?")}`);
  return { ok: true };
}

/**
 * Подбирает недописанные записи, оставшиеся после падения приложения или
 * выключения питания: `*.part.*` старше минуты (активную запись не трогаем)
 * пытается привести в читаемый вид через `ffmpeg -c copy`.
 */
async function recoverPartFiles() {
  const dir = outputDir();
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return { fixed: 0, kept: 0 };
  }
  const parts = names.filter((name) => /\.part\.[^.]+$/i.test(name));
  let fixed = 0;
  let kept = 0;
  for (const name of parts) {
    const partPath = path.join(dir, name);
    const st = await fsp.stat(partPath).catch(() => null);
    if (!st || !st.size) continue;
    if (Date.now() - st.mtimeMs < 60_000) continue; // возможно, запись ещё идёт
    const finalPath = path.join(dir, name.replace(/\.part(\.[^.]+)$/i, "$1"));
    log.warn("capture", `найден недописанный файл ${name} (${st.size} Б), пробую починить [SR2003]`);
    if (!ffmpegPath) {
      kept += 1;
      log.error("capture", `ремонт невозможен без ffmpeg: ${name} [SR5001]`);
      continue;
    }
    const isMp4 = /\.mp4$/i.test(name);
    const args = ["-i", partPath, "-c", "copy"];
    if (isMp4) args.push("-movflags", "+faststart");
    args.push(finalPath);
    const run = await runFfmpeg(args);
    if (run.ok) {
      await fsp.unlink(partPath).catch(() => {});
      fixed += 1;
      log.info("capture", `починен: ${path.basename(finalPath)}`);
    } else {
      kept += 1;
      log.error("capture", `ремонт не удался (${name}): ${String(run.error).slice(0, 300)} [SR2002]`);
    }
  }
  if (parts.length) log.info("capture", `проверка .part: найдено ${parts.length}, починено ${fixed}, оставлено ${kept}`);
  return { fixed, kept };
}

async function saveScreenshot(payload) {
  const dataUrl = typeof payload === "string" ? payload : payload?.dataUrl;
  const rawFormat = (typeof payload === "object" && payload?.format) || "png";
  const format = String(rawFormat).toLowerCase();
  const dir = shotsDir();
  await fsp.mkdir(dir, { recursive: true });
  const base64 = String(dataUrl).replace(/^data:image\/[a-z]+;base64,/, "");

  const imageSpec = IMAGE_ARGS[format];
  if (!imageSpec) {
    const ext = format === "jpg" || format === "jpeg" ? ".jpg" : ".png";
    const filePath = path.join(dir, stampName(ext));
    await fsp.writeFile(filePath, Buffer.from(base64, "base64"));
    return { ok: true, path: filePath, size: (await fsp.stat(filePath)).size };
  }

  // BMP/GIF/TIFF Chromium не отдаёт — сначала PNG, потом ffmpeg.
  const tempPng = path.join(app.getPath("temp"), `screen-revesane-shot-${Date.now()}.png`);
  await fsp.writeFile(tempPng, Buffer.from(base64, "base64"));
  const outPath = path.join(dir, stampName(imageSpec.ext));
  const run = await runFfmpeg(["-i", tempPng, ...imageSpec.args, outPath]);
  await fsp.unlink(tempPng).catch(() => {});
  if (!run.ok) {
    log.error("shot", `снимок не сохранён (${format}): ${String(run.error).slice(0, 300)} [SR4001]`);
    return fail("SR4001", { reason: "ffmpeg", error: run.error });
  }
  const size = (await fsp.stat(outPath)).size;
  log.info("shot", `снимок: ${path.basename(outPath)} · ${size} Б`);
  return { ok: true, path: outPath, size };
}

async function listLibrary() {
  const dirs = [...new Set([outputDir(), shotsDir()])];
  const rows = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/\.part\.[^.]+$/i.test(name)) continue; // недописанная запись — не библиотека
      if (!/\.(mp4|webm|png|jpg|jpeg|mkv|mov|gif|wmv|f4v|ts|bmp|tiff|tif|mp3|m4a|wma|aac|opus|flac|wav)$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        if (st.size === 0) continue; // пустые файлы не показываем
        rows.push({
          name,
          path: full,
          fileUrl: pathToFileURL(full).href,
          size: st.size,
          mtime: st.mtimeMs,
          kind: /\.(png|jpe?g|bmp|tiff|tif)$/i.test(name)
            ? "shot"
            : /\.(mp3|m4a|wma|aac|opus|flac|wav)$/i.test(name)
              ? "audio"
              : "video",
        });
      } catch {
        /* пропускаем исчезнувшие */
      }
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

/**
 * Очистка библиотеки: удаляем только медиафайлы, которые показывает список,
 * и недописанные `.part` (их всё равно не починить). Чужие файлы в папке не
 * трогаем: папку могли выбрать вручную.
 */
async function clearLibrary() {
  const dirs = [...new Set([outputDir(), shotsDir()])];
  const media = /\.(mp4|webm|png|jpg|jpeg|mkv|mov|gif|wmv|f4v|ts|bmp|tiff|tif|mp3|m4a|wma|aac|opus|flac|wav)$/i;
  let removed = 0;
  let freed = 0;
  for (const dir of dirs) {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!media.test(name) && !/\.part\.[^.]+$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        if (!st.isFile()) continue;
        await fsp.unlink(full);
        removed += 1;
        freed += st.size;
      } catch {
        /* занятый файл пропускаем */
      }
    }
  }
  log.info("library", `очистка: удалено ${removed} файлов, ${Math.round(freed / 1048576)} МБ`);
  return { ok: true, removed, freed };
}

// ─────────────────────────────────────────────────────────── IPC

function registerIpc() {
  ipcMain.handle("sources:list", () => showSources());
  ipcMain.handle("self:protect", (_e, enabled) => {
    setSelfProtection(Boolean(enabled));
    return { ok: true };
  });

  ipcMain.handle("capture:start", (_e, payload) => startCapture(payload));
  ipcMain.on("capture:chunk", (_e, chunk) => {
    if (!capture.stream) return;
    const buf = chunkToBuffer(chunk);
    if (!buf) return;
    capture.stream.write(buf);
    armAutostop();
  });
  ipcMain.handle("capture:finish", (_e, payload) => finishCapture(payload ?? {}));
  ipcMain.handle("capture:abort", () => abortCapture());
  ipcMain.handle("capture:screenshot", (_e, dataUrl) => saveScreenshot(dataUrl));

  ipcMain.handle("region:pick", (_e, payload) => pickRegion(payload?.intent === "shot" ? "shot" : "video"));
  ipcMain.on("region:done", (_e, rect) => {
    if (typeof regionFinish === "function") regionFinish(rect ?? null);
  });
  ipcMain.handle("capture:arm", (_e, target) => {
    if (capture.active) return { ok: false, reason: "recording" };
    capture.target = target ?? null;
    return { ok: true };
  });
  // Заявка «следующий getDisplayMedia — только системный звук с экрана».
  // Нужна для записи окна: loopback на Windows выдаётся только экранному источнику.
  ipcMain.handle("capture:loopbackArm", (_e, payload) => {
    capture.audioTarget = { displayId: payload?.displayId ?? null, at: Date.now() };
    return { ok: true };
  });
  ipcMain.handle("settings:get", () => {
    const settings = readSettings();
    return { ...settings, lang: resolveLang(settings.language) };
  });
  ipcMain.handle("hotkeys:check", (_e, payload) => checkHotkey(payload ?? {}));
  ipcMain.handle("update:check", () => checkForUpdates(true));
  ipcMain.handle("update:state", () => ({
    info: update.info,
    downloading: update.downloading,
    ready: Boolean(update.file),
  }));
  ipcMain.handle("update:download", async () => {
    const info = update.info;
    if (!info?.available || !info.asset) return { ok: false, error: "no update" };
    if (!canInstallUpdate()) return { ok: false, error: "not packaged" };
    if (update.downloading) return { ok: false, error: "busy" };
    update.downloading = true;
    try {
      const result = await updater.downloadAsset({
        fetch: (url, init) => net.fetch(url, init),
        asset: info.asset,
        dir: UPDATE_DIR,
        onProgress: (progress) => mainWindow?.webContents.send("update:progress", progress),
      });
      if (result.ok) {
        update.file = result.path;
        log.info("update", `скачан ${path.basename(result.path)}${result.verified ? " (SHA-256 сверен)" : ""}`);
      } else {
        log.error("update", `скачать обновление не удалось: ${result.error}`);
      }
      return result;
    } finally {
      update.downloading = false;
    }
  });
  ipcMain.handle("update:install", async () => {
    if (!update.file) return { ok: false, error: "not downloaded" };
    if (capture.active) return { ok: false, error: "recording" };
    if (process.platform === "darwin") {
      // macOS: открываем образ диска — программу перетаскивают в «Программы».
      const error = await shell.openPath(update.file);
      return error ? { ok: false, error } : { ok: true, mode: "dmg" };
    }
    try {
      const child = spawn(update.file, [], { detached: true, stdio: "ignore" });
      child.unref();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    log.info("update", "установщик запущен, программа закрывается");
    setTimeout(() => app.quit(), 400);
    return { ok: true, mode: "installer" };
  });
  ipcMain.handle("update:openPage", () => {
    const page = update.info?.page;
    void shell.openExternal(updater.isTrustedUrl(page) ? page : updater.RELEASES_PAGE);
    return true;
  });
  // Свободное место в папке записей — для подсказки «мало места на диске».
  ipcMain.handle("disk:free", async () => {
    try {
      const stat = await fsp.statfs(outputDir());
      return { ok: true, bytes: Number(stat.bavail) * Number(stat.bsize) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("settings:set", async (_e, patch) => {
    const next = await writeSettings(patch);
    let hotkeyErrors = [];
    if (patch && typeof patch === "object" && "hotkeys" in patch) hotkeyErrors = registerHotkeys();
    if (patch && typeof patch === "object" && "showPanel" in patch && !capture.active) hidePanel();
    const lang = resolveLang(next.language);
    if (patch && typeof patch === "object" && "language" in patch) {
      I18N.setLang(lang);
      for (const win of [mainWindow, panelWindow, frameWindow, regionWindow]) {
        try {
          if (win && !win.isDestroyed()) win.webContents.send("lang:changed", lang);
        } catch {
          /* окно уже закрыто */
        }
      }
    }
    return { ...next, lang, hotkeyErrors };
  });
  ipcMain.handle("library:list", () => listLibrary());
  ipcMain.handle("library:clear", () => clearLibrary());
  ipcMain.handle("library:trim", (_e, payload) => trimMedia(payload ?? {}));
  ipcMain.handle("library:snapshot", (_e, payload) => snapshotFromVideo(payload ?? {}));
  ipcMain.handle("library:delete", (_e, payload) => deleteMedia(payload ?? {}));
  ipcMain.handle("library:preview", (_e, payload) => makePreview(payload?.filePath, { force: payload?.force === true }));
  // Проба медиафайла нужна самопроверке: доказать, что в записи окна есть звук.
  ipcMain.handle("library:probe", (_e, payload) => probeMedia(payload?.filePath));
  ipcMain.handle("library:merge", (_e, payload) => mergeMedia(payload ?? {}));
  ipcMain.handle("library:speed", (_e, payload) => speedMedia(payload ?? {}));
  ipcMain.handle("library:readImage", (_e, payload) => readImageAsDataUrl(payload?.filePath));
  ipcMain.handle("library:saveAnnotated", (_e, payload) => saveAnnotated(payload ?? {}));
  ipcMain.handle("clipboard:writeImage", (_e, payload) => {
    try {
      const dataUrl = payload?.dataUrl;
      if (!dataUrl) return { ok: false, reason: "no-image" };
      const image = nativeImage.createFromDataURL(String(dataUrl));
      if (image.isEmpty()) return { ok: false, reason: "empty-image" };
      // В этой сборке Electron у clipboard нет writeImage/readImage —
      // класть картинку можно общим write({ image }), он есть.
      if (typeof clipboard.writeImage === "function") {
        clipboard.writeImage(image);
      } else {
        clipboard.write({ image });
      }
      const formats = typeof clipboard.availableFormats === "function" ? clipboard.availableFormats() : [];
      const hasImage = typeof clipboard.has === "function" ? clipboard.has("image/png") : formats.some((f) => /image/i.test(f));
      if (!hasImage) return { ok: false, reason: "clipboard-empty", formats };
      return { ok: true, formats };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Выбор картинки для водяного знака.
  ipcMain.handle("dialog:chooseImage", async (_e, current) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: I18N.t("Картинка водяного знака"),
      properties: ["openFile"],
      filters: [{ name: "PNG", extensions: ["png"] }],
      defaultPath: typeof current === "string" && current ? current : undefined,
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("dialog:chooseDir", async (_e, current) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: I18N.t("Папка для сохранения"),
      properties: ["openDirectory", "createDirectory"],
      defaultPath: typeof current === "string" && current ? current : outputDir(),
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.on("panel:state", (_e, state) => {
    panelWindow?.webContents.send("panel:state", state);
    // Тот же таймер и признак паузы нужны рамке записываемой области.
    frameWindow?.webContents.send("frame:state", state);
  });
  ipcMain.handle("frame:show", (_e, payload) => showRecordingFrame(payload ?? {}));
  ipcMain.handle("frame:hide", () => hideRecordingFrame());
  // Прогрев захвата: рендерер открывает getDisplayMedia заранее, обработчик
  // выше возьмёт источник из prewarmTarget.
  ipcMain.handle("capture:prewarm", (_e, payload) => {
    capture.prewarmTarget = payload?.target ?? null;
    return { ok: Boolean(capture.prewarmTarget) };
  });
  // Повторное нажатие клавиши «выделить и записать видео» при открытом оверлее
  // подтверждает уже нарисованную рамку — без мыши и без Enter.
  ipcMain.on("region:confirm", () => {
    if (!regionWindow) return;
    try {
      regionWindow.webContents.send("region:confirm");
    } catch {
      /* окно уже закрывается */
    }
  });
  ipcMain.on("panel:command", (_e, action) => {
    mainWindow?.webContents.send("record:command", action);
  });

  ipcMain.handle("shell:reveal", (_e, target) => {
    if (typeof target === "string" && target) shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle("shell:open", async (_e, target) => {
    const res = await shell.openPath(target);
    return res || "ok";
  });
  ipcMain.handle("shell:openOutputDir", async () => {
    const dir = outputDir();
    await fsp.mkdir(dir, { recursive: true });
    return shell.openPath(dir);
  });

  ipcMain.handle("app:info", () => {
    const settings = readSettings();
    return {
      name: "Screen Revesane",
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      appPath: app.getAppPath(),
      // Когда собрана именно эта копия интерфейса. Отвечает на вопрос «я смотрю
      // новую сборку или старое окно?» без лазания в файлы.
      buildTime: rendererBuildTime(),
      outputDir: outputDir(),
      outputDirShots: shotsDir(),
      settingsPath: SETTINGS_PATH,
      logPath: log.file(),
      logDir: log.dir(),
      crashDumps: CRASH_DUMPS_DIR,
      ffmpeg: Boolean(ffmpegPath),
      ffmpegSource: ffmpegSource,
      hotkeys: settings.hotkeys ?? DEFAULT_SETTINGS.hotkeys,
      containers: ["auto", "mp4", "mkv", "mov", "webm", "wmv", "f4v", "ts", "gif"],
      audioFormats: ["mp3", "m4a", "wma", "aac", "opus", "flac", "wav"],
      imageFormats: ["png", "jpg", "bmp", "gif", "tiff"],
      codecMatrix: CONTAINER_CODECS,
      codecLabels: {
        video: Object.fromEntries(Object.entries(VIDEO_CODECS).map(([key, value]) => [key, I18N.t(value.label)])),
        audio: Object.fromEntries(Object.entries(AUDIO_CODECS).map(([key, value]) => [key, I18N.t(value.label)])),
      },
      selftest: SELFTEST,
      // Автопрогоны (самопроверка, снимки интерфейса): тур не запускается сам.
      automation: SELFTEST || SELFTEST_MODES || UI_SHOTS,
    };
  });

  ipcMain.handle("app:log", (_e, payload) => {
    const level = String(payload?.level || "info").toLowerCase();
    const message = String(payload?.message || "").slice(0, 2000);
    if (!message) return false;
    const module = String(payload?.module || "ui").slice(0, 24);
    if (level === "error") log.error(module, message);
    else if (level === "warn") log.warn(module, message);
    else log.info(module, message);
    return true;
  });
  ipcMain.handle("log:openDir", async () => {
    const dir = log.dir();
    if (!dir) return { ok: false, reason: "no-log" };
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const error = await shell.openPath(dir);
    return { ok: !error, error };
  });
  ipcMain.handle("log:tail", async (_e, payload) => log.tail(Number(payload?.lines) || 80));

  ipcMain.handle("win:focus", () => {
    if (!mainWindow) return false;
    try {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.on("win:minimize", () => mainWindow?.minimize());
  ipcMain.handle("win:compact", (_e, compact) => setCompactWindow(Boolean(compact)));
  ipcMain.on("win:maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on("win:restore", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
  });
  ipcMain.handle("win:contentProtection", (_e, enabled) => {
    try {
      mainWindow?.setContentProtection(Boolean(enabled));
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.on("win:close", () => mainWindow?.close());

  ipcMain.handle("selftest:report", async (_e, result) => {
    const shots = {};
    if (!SELFTEST_MODES) {
      Object.assign(shots, await captureUiShots());
    }
    let clipboardHasImage = null;
    try {
      clipboardHasImage = typeof clipboard.readImage === "function"
        ? !clipboard.readImage().isEmpty()
        : null;
    } catch {
      clipboardHasImage = null;
    }

    const report = {
      ...result,
      uiShots: shots,
      testTarget: testTargetInfo,
      clipboardHasImage,
      ffmpeg: Boolean(ffmpegPath),
    };
    const line = SELFTEST_MODES ? "MODES_RESULT" : "SELFTEST_RESULT";
    process.stdout.write(`\n${line} ${JSON.stringify(report)}\n`);
    setTimeout(() => app.quit(), 300);
    return true;
  });
}

// ─────────────────────────────────────────────── плавающая панель записи

let panelWindow = null;

function showPanel(style) {
  const ball = style === "ball";
  if (!panelWindow) {
    panelWindow = new BrowserWindow({
      width: ball ? 104 : 272,
      height: ball ? 104 : 62,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      focusable: false,
      webPreferences: {
        preload: path.join(ROOT, "src", "panel", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    panelWindow.setAlwaysOnTop(true, "screen-saver");
    // Панель не должна попадать в собственную запись.
    try {
      panelWindow.setContentProtection(true);
    } catch {
      /* не критично */
    }
    panelWindow.loadFile(path.join(ROOT, "src", "panel", "panel.html"), {
      query: { lang: resolveLang(readSettings().language) },
    });
    panelWindow.webContents.once("did-finish-load", () => {
      panelWindow?.webContents.send("panel:style", ball ? "ball" : "full");
    });
    panelWindow.on("closed", () => {
      panelWindow = null;
    });
  } else {
    panelWindow.setSize(ball ? 104 : 272, ball ? 104 : 62, false);
    panelWindow.webContents.send("panel:style", ball ? "ball" : "full");
  }

  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  panelWindow.setPosition(x + width - (ball ? 128 : 300), y + height - (ball ? 128 : 94), false);
}

function hidePanel() {
  if (!panelWindow) return;
  const win = panelWindow;
  panelWindow = null;
  try {
    win.destroy();
  } catch {
    /* уже закрыто */
  }
}

// ─────────────────────────────────────────── рамка записываемой области

let frameWindow = null;

/**
 * Рамка вокруг записываемой области на время записи.
 *
 * Раньше после подтверждения оверлей просто исчезал, и было непонятно, что
 * именно пишется. Теперь на экране остаётся тонкий контур с пульсирующим
 * значком REC и таймером. В кадр она не попадает: окно помечено
 * `setContentProtection` (WDA_EXCLUDEFROMCAPTURE), поэтому его нет в захвате
 * WGC. Клики проходят сквозь рамку — она не мешает работать в области.
 */
function showRecordingFrame(payload = {}) {
  const region = payload.region;
  if (!region || !(Number(region.width) >= 8) || !(Number(region.height) >= 8)) {
    log.warn("frame", "рамка записи не создана: нет размеров области");
    return { ok: false };
  }

  const displays = screen.getAllDisplays();
  const display =
    displays.find((d) => String(d.id) === String(region.displayId)) ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = {
    x: Math.round(display.bounds.x + Number(region.x)),
    y: Math.round(display.bounds.y + Number(region.y)),
    width: Math.round(Number(region.width)),
    height: Math.round(Number(region.height)),
  };

  hideRecordingFrame();
  frameWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Фокус не забираем: запись области не должна выдёргивать пользователя
    // из программы, которую он пишет.
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, "src", "frame", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  frameWindow.setAlwaysOnTop(true, "screen-saver");
  // Клики — мимо рамки, в окно под ней.
  frameWindow.setIgnoreMouseEvents(true, { forward: true });
  // Главное: рамка исключается из захвата и в видео не попадает.
  try {
    frameWindow.setContentProtection(true);
  } catch {
    /* не критично */
  }
  frameWindow.loadFile(path.join(ROOT, "src", "frame", "frame.html"), {
    query: {
      w: String(bounds.width),
      h: String(bounds.height),
      // Формат записи виден в значке рядом с таймером.
      format: String(payload.format || ""),
      // Язык интерфейса рамки — сразу, без ожидания события от main.
      lang: resolveLang(readSettings().language),
    },
  });
  frameWindow.once("ready-to-show", () => {
    try {
      frameWindow?.showInactive();
    } catch {
      /* окно уже закрыто */
    }
  });
  frameWindow.webContents.once("did-finish-load", () => {
    // Первое состояние — сразу, чтобы таймер не ждал первого тика.
    frameWindow?.webContents.send("frame:state", payload.state ?? { elapsedMs: 0, paused: false });
  });
  frameWindow.on("closed", () => {
    frameWindow = null;
  });
  log.info(
    "frame",
    `рамка записи: ${bounds.width}×${bounds.height} в (${bounds.x}, ${bounds.y}) · ` +
      `дисплей ${display.id}`,
  );
  return { ok: true };
}

function hideRecordingFrame() {
  if (!frameWindow) return { ok: true };
  const win = frameWindow;
  frameWindow = null;
  try {
    win.destroy();
  } catch {
    /* уже закрыто */
  }
  return { ok: true };
}

// ─────────────────────────────────────────── компактный режим окна

/** Размер «карманного» окна. Меняется здесь, разметка подстраивается. */
const COMPACT_BOUNDS = { width: 470, height: 306 };
let normalWindowBounds = null;

/**
 * Компактный режим: окно уменьшается до 470×306, уезжает в правый нижний угол
 * и остаётся поверх остальных, чтобы запись можно было запускать, не отвлекаясь
 * от работы. Обратно — те же кнопки в заголовке.
 */
function setCompactWindow(compact) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  if (compact) {
    if (!normalWindowBounds) normalWindowBounds = mainWindow.getBounds();
    // Без снятия минимального размера Windows не даст окну стать маленьким.
    mainWindow.setMinimumSize(360, 240);
    mainWindow.setResizable(false);
    const display =
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
    const area = display.workArea;
    mainWindow.setBounds({
      x: Math.round(area.x + area.width - COMPACT_BOUNDS.width - 24),
      y: Math.round(area.y + area.height - COMPACT_BOUNDS.height - 24),
      width: COMPACT_BOUNDS.width,
      height: COMPACT_BOUNDS.height,
    });
    mainWindow.setAlwaysOnTop(true, "floating");
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    log.info("win", `компактный режим: ${COMPACT_BOUNDS.width}×${COMPACT_BOUNDS.height}`);
    return { ok: true, compact: true };
  }
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(1080, 620);
  if (normalWindowBounds) mainWindow.setBounds(normalWindowBounds);
  normalWindowBounds = null;
  log.info("win", "обычный режим окна");
  return { ok: true, compact: false };
}

/**
 * Действия с глобальными клавишами: один список и для регистрации, и для
 * сообщений об ошибках. Новые действия по умолчанию пустые — глобальная
 * клавиша воруется у всей системы, поэтому назначает её пользователь.
 */
const HOTKEY_ACTIONS = [
  { name: "toggle", label: "старт/стоп" },
  { name: "stop", label: "только стоп" },
  { name: "pause", label: "пауза" },
  { name: "screenshot", label: "скриншот" },
  { name: "region", label: "выделить и записать видео" },
  { name: "regionShot", label: "снимок области" },
  { name: "library", label: "библиотека" },
  { name: "mic", label: "микрофон вкл/выкл" },
  { name: "panel", label: "плавающая панель" },
];

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const keys = readSettings().hotkeys ?? DEFAULT_SETTINGS.hotkeys;
  const failed = [];
  for (const action of HOTKEY_ACTIONS) {
    const accelerator = keys[action.name];
    if (!accelerator) continue;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        // Канал совпадает с именем действия: hotkey:toggle, hotkey:regionShot…
        mainWindow?.webContents.send(`hotkey:${action.name}`);
      });
      if (!ok) failed.push(I18N.t("{0} ({1}) — занято другой программой", I18N.t(action.label), accelerator));
    } catch (err) {
      failed.push(I18N.t("{0} ({1}) — {2}", I18N.t(action.label), accelerator, err.message));
    }
  }
  return failed;
}

/** Одно и то же сочетание в разных записях — сравниваем без учёта регистра и порядка модификаторов. */
function sameAccelerator(left, right) {
  const normalize = (value) =>
    String(value || "")
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const lower = part.toLowerCase();
        if (lower === "ctrl" || lower === "control" || lower === "commandorcontrol" || lower === "cmdorctrl") {
          return "control";
        }
        if (lower === "alt") return "alt";
        if (lower === "shift") return "shift";
        if (lower === "super" || lower === "meta" || lower === "win") return "super";
        return part.toUpperCase();
      })
      .sort()
      .join("+");
  return Boolean(left && right) && normalize(left) === normalize(right);
}

/**
 * Проверка сочетания ДО записи в настройки: занято ли оно другим действием
 * и отдаёт ли его система (глобально клавишу может держать другая программа).
 * Прежние привязки после проверки восстанавливаются.
 */
function checkHotkey({ name, accelerator }) {
  if (!accelerator) return { ok: true, empty: true };
  const keys = readSettings().hotkeys ?? DEFAULT_SETTINGS.hotkeys;
  for (const [other, value] of Object.entries(keys)) {
    if (other === name || !value) continue;
    if (sameAccelerator(value, accelerator)) {
      return { ok: false, reason: "duplicate", owner: other, ownerKey: value };
    }
  }
  let result = { ok: true };
  globalShortcut.unregisterAll();
  try {
    const taken = globalShortcut.register(accelerator, () => {});
    if (taken) globalShortcut.unregister(accelerator);
    else result = { ok: false, reason: "busy" };
  } catch (err) {
    result = { ok: false, reason: "invalid", error: err.message };
  }
  registerHotkeys();
  return result;
}

// ─────────────────────────────────────────────────────────── старт

app.whenReady().then(async () => {
  // На macOS пустое меню ломает Cmd+C/V и выход: mac-приложению нужен
  // стандартный набор ролей. На Windows свой рамочный интерфейс — меню нет.
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
  // Свой идентификатор: панель задач группирует окна и берёт значок по нему, а не у Electron.
  app.setAppUserModelId("com.screenrevesane.app");
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(APP_ICON);
    } catch {
      /* значок дока не критичен */
    }
  }
  log.init(app.getPath("userData"));
  log.info("app", `${app.getName()} ${app.getVersion()} · Electron ${process.versions.electron} · Node ${process.versions.node}`);
  log.info("app", `логи: ${log.file()}`);
  await fsp.mkdir(outputDir(), { recursive: true }).catch(() => {});
  ffmpegPath = await probeFfmpeg();
  ffprobePath = await probeFfprobe();
  log.info("app", `ffmpeg: ${ffmpegPath ? "найден" : "нет"}, ffprobe: ${ffprobePath ? "найден" : "нет"}`);
  // Своего ffmpeg нет — берём скачанную копию, а если и её нет, качаем в фоне:
  // интерфейс поднимается сразу, ffmpeg приезжает сам и без прав администратора.
  if (!ffmpegPath || !ffprobePath) {
    void ffmpegFetch.ensureFfmpeg({
      toolsDir: TOOLS_DIR,
      havePath: Boolean(ffmpegPath && ffprobePath),
      // Сеть — стек Chromium: системный прокси работает так же, как в браузере.
      fetch: (url, init) => net.fetch(url, init),
      onEvent: handleFfmpegEvent,
    });
  }
  installDisplayMediaHandler();
  registerIpc();
  // Язык выбирается до создания окон: первые же строки интерфейса и сообщений
  // main-процесса должны быть на нужном языке.
  I18N.setLang(resolveLang(readSettings().language));
  createMainWindow();
  if (SELFTEST_MODES) createTestTarget();
  registerHotkeys();
  scheduleUpdateChecks();
  // Недописанные записи от прошлых падений чиним после того, как известен ffmpeg.
  void recoverPartFiles().catch((err) => log.error("capture", `recoverPartFiles: ${err.message}`));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || SELFTEST) app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (capture.stream) capture.stream.end();
});

// Падение не должно оставлять пользователя без объяснения: пишем в лог и,
// если запись активна, отпускаем файловый поток, чтобы .part можно было починить.
process.on("uncaughtException", (err) => {
  log.error("app", `uncaughtException: ${err?.stack || err}`);
  try {
    if (capture.stream) capture.stream.end();
  } catch {
    /* уже закрыт */
  }
});

process.on("unhandledRejection", (reason) => {
  log.error("app", `unhandledRejection: ${reason?.stack || reason}`);
});
