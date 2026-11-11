"use strict";

/**
 * Движок записи: getDisplayMedia → canvas-композиция (обрезка области,
 * PiP веб-камеры) → MediaRecorder → чанки в главный процесс.
 *
 * Кадры рисуются по таймеру, а не по requestAnimationFrame: окно может быть
 * свёрнуто, и rAF в этот момент останавливается, а setInterval — нет
 * (backgroundThrottling выключен в main).
 */

const MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4;codecs="avc1.42E01E"',
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const QUALITY_FACTOR = { low: 0.05, balanced: 0.1, high: 0.18 };

export function pickMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* пробуем следующий */
    }
  }
  return "";
}

export function mimeToExt(mime) {
  return mime && mime.startsWith("video/mp4") ? ".mp4" : ".webm";
}

export class Recorder {
  constructor({ onChunk, onError, onTick } = {}) {
    this.onChunk = onChunk || (() => {});
    this.onError = onError || (() => {});
    this.onTick = onTick || (() => {});

    this.active = false;
    this.paused = false;
    this.chunks = 0;
    this.bytes = 0;
    this.mimeType = null;
    this.startedAt = 0;
    this.pausedMs = 0;
    this.pausedAt = 0;

    this._video = null;
    this._webcamVideo = null;
    this._canvas = null;
    this._ctx = null;
    this._drawTimer = null;
    this._rvfcHandle = null;
    this._display = null;
    this._loopback = null;
    this._micStream = null;
    this._sysDeviceStream = null;
    this._webcamStream = null;
    this._audioCtx = null;
    this._recorder = null;
    this._composite = null;
    this._geom = null;
    // Анализаторы уровня: микрофон и системный звук отдельно, чтобы полосы
    // в интерфейсе показывали именно свои дорожки, а не сведённую смесь.
    this._meters = { mic: null, system: null };
    // Прогретый захват: открыт заранее, пока человек выделяет область.
    this._warm = null;
  }

  /** Длительность записи без учёта пауз, мс. */
  get elapsedMs() {
    if (!this.startedAt) return 0;
    const now = this.paused ? this.pausedAt : Date.now();
    return Math.max(0, now - this.startedAt - this.pausedMs);
  }

  /**
   * Прогрев захвата.
   *
   * WGC на этой машине отдаёт первый кадр через 4–5 с, поэтому поток
   * открывается заранее — пока человек выделяет область. К подтверждению
   * рамки захват уже живой, и запись стартует почти сразу.
   */
  async prewarm({ target, fps = 30, systemAudio = true, arm = null } = {}) {
    this.dropPrewarm();
    try {
      if (typeof arm === "function") await arm();
      const stream = await withTimeout(
        navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: Math.min(60, Math.max(5, fps)) },
          audio: Boolean(systemAudio) && target?.kind === "screen",
        }),
        15000,
        "getDisplayMedia не ответил за 15 с",
      );
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("нет видеодорожки экрана");
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      await video.play().catch(() => {});
      const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
      this._warm = {
        stream,
        video,
        sourceId: target?.sourceId ?? null,
        kind: target?.kind ?? "screen",
        width: Number(settings.width) || 0,
        height: Number(settings.height) || 0,
        at: Date.now(),
      };
      return { ok: true };
    } catch (err) {
      this._warm = null;
      return { ok: false, error: err.name || err.message };
    }
  }

  /** Отпускает прогретый поток, если запись так и не началась (отмена). */
  dropPrewarm() {
    const warm = this._warm;
    this._warm = null;
    if (!warm?.stream) return;
    try {
      warm.stream.getTracks().forEach((track) => track.stop());
    } catch {
      /* уже остановлены */
    }
  }

  /** Забирает прогретый поток, если он живой и от того же источника. */
  _takeWarm(target) {
    const warm = this._warm;
    this._warm = null;
    if (!warm) return null;
    let live = false;
    try {
      live = warm.stream.getVideoTracks().some((track) => track.readyState === "live");
    } catch {
      live = false;
    }
    const sameSource = !target?.sourceId || !warm.sourceId || warm.sourceId === target.sourceId;
    if (live && sameSource && Date.now() - warm.at < 120000) return warm;
    try {
      warm.stream.getTracks().forEach((track) => track.stop());
    } catch {
      /* уже остановлены */
    }
    return null;
  }

  async start({
    target,
    crop,
    display = null,
    fps = 30,
    quality = "balanced",
    mic = false,
    systemAudio = true,
    webcam = false,
    loopbackArm = null,
    placeholder = null,
    micDevice = "",
    micVolume = 100,
    systemVolume = 100,
    micCleanup = true,
    systemDevice = "",
  }) {
    if (this.active) throw new Error("запись уже идёт");

    // Звук компьютера берём либо loopback-ом Windows, либо с выбранного входа
    // (интерфейс, виртуальный кабель): DAW на ASIO в микшер Windows не попадает.
    const wantLoopback = Boolean(systemAudio) && !systemDevice;
    const warnings = [];
    const mimeType = pickMimeType();
    if (mimeType === null) throw new Error("MediaRecorder недоступен в этом окне");

    // Замер этапов старта: на этой машине WGC отдаёт первый кадр через ~5 с,
    // и без разбивки по шагам непонятно, что именно ждать.
    const t0 = performance.now();
    const mark = (label) =>
      console.warn(`[capture-timing] ${label}: ${Math.round(performance.now() - t0)} мс`);

    // 1. Захват экрана/окна: прогретый поток (его открыл prewarm, пока человек
    //    выделял область) или свежий getDisplayMedia. Обработчик в main выберет
    //    источник по capture.prewarmTarget/capture.target.
    let vw = 0;
    let vh = 0;
    const warm = this._takeWarm(target);
    if (warm) {
      this._display = warm.stream;
      this._video = warm.video;
      vw = warm.width;
      vh = warm.height;
      mark("прогретый захват");
    } else {
      this._display = await withTimeout(
        navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: Math.min(60, Math.max(5, fps)) },
          audio: wantLoopback && target.kind === "screen",
        }),
        15000,
        "getDisplayMedia не ответил за 15 с",
      );
      mark("getDisplayMedia");

      const freshTrack = this._display.getVideoTracks()[0];
      if (!freshTrack) throw new Error("нет видеодорожки экрана");
      this._video = document.createElement("video");
      this._video.muted = true;
      this._video.playsInline = true;
      this._video.srcObject = new MediaStream([freshTrack]);
      await this._video.play();

      // Размер кадра берём из настроек дорожки: он известен сразу после
      // getDisplayMedia, а первый живой кадр WGC на этой машине отдаёт через
      // 4–5 с. Раньше здесь ждали videoWidth, и старт растягивался на всё это.
      const trackSettings =
        typeof freshTrack.getSettings === "function" ? freshTrack.getSettings() : {};
      vw = Number(trackSettings.width) || this._video.videoWidth;
      vh = Number(trackSettings.height) || this._video.videoHeight;
      if (!(vw > 1) || !(vh > 1)) {
        await waitFor(freshTrack, "loadedmetadata", 3000).catch(() => {});
        await waitUntil(() => this._video.videoWidth > 1, 3000).catch(() => {});
        vw = this._video.videoWidth;
        vh = this._video.videoHeight;
      }
      mark("размер кадра");
    }

    // 1.5. Окно не отдаёт loopback (на Windows он только для экрана), поэтому
    //      системный звук берём ВТОРОЙ сессией захвата: экран + звук, а видео
    //      оттуда не используется. Отдельная дорожка идёт только в микс.
    let loopbackTracks = [];
    if (wantLoopback && target.kind !== "screen" && typeof loopbackArm === "function") {
      try {
        await loopbackArm();
        this._loopback = await withTimeout(
          navigator.mediaDevices.getDisplayMedia({
            // Минимальная нагрузка: кадры не нужны, только звуковая дорожка.
            video: { frameRate: { max: 2 }, width: { max: 320 }, height: { max: 180 } },
            audio: true,
          }),
          15000,
          "звук экрана не ответил за 15 с",
        );
        loopbackTracks = this._loopback.getAudioTracks();
        if (!loopbackTracks.length) {
          warnings.push("Chromium не отдал системный звук для окна — дорожка будет без него");
        }
      } catch (err) {
        warnings.push(`системный звук не открылся: ${err.name || err.message}`);
      }
    }

    // 1.9. Проверка размера кадра.
    //
    // Сессия захвата экрана в Chromium одна на приложение: если в этот момент
    // жива индикация уровня (превью 160×90), запись наследует её размеры — в
    // самотесте так выходило «выделено 450×340, записано 28×20». Такой кадр
    // бракуем и перезапрашиваем захват, когда сессия точно освободилась.
    const expectedWidth =
      Number(crop?.displaySize?.width) || Number(display?.bounds?.width) || 0;
    if (!warm && target.kind === "screen" && expectedWidth && vw > 0 && vw < expectedWidth * 0.9) {
      console.warn(`[capture] захват отдал ${vw}px вместо ${expectedWidth}px — перезапрашиваю`);
      try {
        this._display.getTracks().forEach((track) => track.stop());
      } catch {
        /* уже остановлены */
      }
      try {
        this._video.srcObject = null;
      } catch {
        /* уже отвязан */
      }
      await sleep(600);
      const retry = await withTimeout(
        navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: Math.min(60, Math.max(5, fps)) },
          audio: wantLoopback && target.kind === "screen",
        }),
        15000,
        "getDisplayMedia не ответил за 15 с",
      );
      const retryTrack = retry.getVideoTracks()[0];
      if (!retryTrack) throw new Error("нет видеодорожки экрана");
      this._display = retry;
      this._video = document.createElement("video");
      this._video.muted = true;
      this._video.playsInline = true;
      this._video.srcObject = new MediaStream([retryTrack]);
      await this._video.play();
      const retrySettings =
        typeof retryTrack.getSettings === "function" ? retryTrack.getSettings() : {};
      vw = Number(retrySettings.width) || this._video.videoWidth;
      vh = Number(retrySettings.height) || this._video.videoHeight;
      if (!(vw > 1) || !(vh > 1)) {
        await waitFor(retryTrack, "loadedmetadata", 3000).catch(() => {});
        await waitUntil(() => this._video.videoWidth > 1, 3000).catch(() => {});
        vw = this._video.videoWidth;
        vh = this._video.videoHeight;
      }
      mark("повторный захват");
    }

    const videoTrack = this._display.getVideoTracks()[0];
    if (!videoTrack) throw new Error("нет видеодорожки экрана");

    // 2. Геометрия: обрезка области в пикселях устройства.
    if (!vw || !vh) throw new Error("поток экрана не отдал размер кадра");

    let cx = 0;
    let cy = 0;
    let cw = vw;
    let ch = vh;
    if (crop) {
      const scale = vw / crop.displaySize.width;
      cx = Math.round(crop.x * scale);
      cy = Math.round(crop.y * scale);
      cw = Math.round(crop.width * scale);
      ch = Math.round(crop.height * scale);
      cx = Math.max(0, Math.min(vw - 2, cx));
      cy = Math.max(0, Math.min(vh - 2, cy));
      cw = Math.max(2, Math.min(vw - cx, cw));
      ch = Math.max(2, Math.min(vh - cy, ch));
    }
    cw = cw - (cw % 2);
    ch = ch - (ch % 2);
    this._geom = { cx, cy, cw, ch };
    this._sourceSize = { width: vw, height: vh };
    this._displayInfo = display;
    // Курсор сопоставляется с целым монитором, поэтому для захвата окна
    // координаты не совпадают с кадром — там подсветку не рисуем.
    this._cursorAllowed = target.kind === "screen";
    this._cursor = null;

    // 3. Canvas-композиция.
    this._canvas = document.createElement("canvas");
    this._canvas.width = cw;
    this._canvas.height = ch;
    // Отладка записи: по счётчику кадров видно, рисуется ли холст во время
    // записи, — без него обрыв длительности неоткуда заметить.
    this._drawCount = 0;
    if (typeof window !== "undefined") window.__srRecorder = this;
    this._ctx = this._canvas.getContext("2d", { alpha: false, desynchronized: true });
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = "high";
    this._ctx.fillStyle = "#000";
    this._ctx.fillRect(0, 0, cw, ch);

    // 3.5. Заглушка до первого живого кадра: снимок выделенной области,
    // снятый перед стартом. Без неё первые 4–5 с записи были бы чёрными.
    if (placeholder) {
      try {
        const image = new Image();
        image.src = placeholder;
        await image.decode();
        this._placeholder = image;
      } catch (err) {
        warnings.push(`заглушка не загрузилась: ${err.name || err.message}`);
      }
    }

    // 4. Веб-камера поверх записи (если есть чем снимать).
    if (webcam) {
      try {
        this._webcamStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, frameRate: 30 },
          audio: false,
        });
        this._webcamVideo = document.createElement("video");
        this._webcamVideo.muted = true;
        this._webcamVideo.playsInline = true;
        this._webcamVideo.srcObject = this._webcamStream;
        await this._webcamVideo.play();
      } catch (err) {
        warnings.push(`веб-камера недоступна: ${err.name || err.message}`);
        this._webcamStream = null;
        this._webcamVideo = null;
      }
    }

    // 5. Сведение звука: микрофон + системный звук в одну дорожку.
    const audioTracks = [];
    const displayAudio = this._display.getAudioTracks();
    const deviceTracks = await this._openSystemDevice(systemAudio && systemDevice, warnings);
    const systemTracks = deviceTracks.length ? deviceTracks : displayAudio.length ? displayAudio : loopbackTracks;
    const hasSystemAudio = systemTracks.length > 0;
    if (mic || hasSystemAudio) {
      try {
        this._audioCtx = new AudioContext();
        if (this._audioCtx.state === "suspended") await this._audioCtx.resume();
        const dest = this._audioCtx.createMediaStreamDestination();
        this._gains = {};

    if (mic) {
      try {
        // Выбранный в настройках аудиовход: без deviceId берём системный.
        const micConstraints = {
          echoCancellation: micCleanup,
          noiseSuppression: micCleanup,
          autoGainControl: micCleanup,
        };
        if (micDevice) micConstraints.deviceId = { exact: micDevice };
        this._micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
        const micSource = this._audioCtx.createMediaStreamSource(this._micStream);
        this._connectWithGain("mic", micSource, dest, micVolume);
        this._meters.mic = this._meterFor(micSource);
      } catch (err) {
        warnings.push(`микрофон недоступен: ${err.name || err.message}`);
      }
    }
    if (hasSystemAudio) {
      const sysStream = new MediaStream(systemTracks);
      const sysSource = this._audioCtx.createMediaStreamSource(sysStream);
      this._connectWithGain("system", sysSource, dest, systemVolume);
      this._meters.system = this._meterFor(sysSource);
    }
    audioTracks.push(...dest.stream.getAudioTracks());
      } catch (err) {
        warnings.push(`звук не сведён: ${err.name || err.message}`);
      }
    }
    if (wantLoopback && !hasSystemAudio && target.kind === "screen") {
      warnings.push("системный звук не отдан Chromium — дорожка будет без него");
    }

    // 6. Первый живой кадр не ждём: пока WGC его не отдал, рисуем заглушку —
    //    снимок области. Запись стартует сразу, а не через 5 с.
    this._draw();
    mark("первый кадр (заглушка)");

    // 7. Поток на запись и сам MediaRecorder.
    const canvasStream = this._canvas.captureStream(Math.min(60, Math.max(5, fps)));
    this._composite = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);

    const bitrate = Math.max(
      800_000,
      Math.round(cw * ch * fps * (QUALITY_FACTOR[quality] ?? QUALITY_FACTOR.balanced)),
    );
    const options = { videoBitsPerSecond: bitrate };
    if (mimeType) options.mimeType = mimeType;

    this._recorder = new MediaRecorder(this._composite, options);
    this.mimeType = this._recorder.mimeType;

    this.chunks = 0;
    this.bytes = 0;
    this._chunkLog = [];
    // Чтение блоба асинхронное: последний чанк (а он самый большой — муксер
    // отдаёт его при остановке) мог не успеть дойти до main, и запись
    // обрывалась на несколько секунд раньше. Держим задачи, чтобы дождаться.
    this._pendingChunks = new Set();
    this._recorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size === 0) return;
      this.chunks += 1;
      const task = (async () => {
        const buffer = await event.data.arrayBuffer();
        this.bytes += buffer.byteLength;
        // Отладка: по таймингам чанков видно, когда энкодер получил первый кадр.
        this._chunkLog.push({ at: Math.round(this.elapsedMs), size: buffer.byteLength });
        this.onChunk(buffer);
      })();
      this._pendingChunks.add(task);
      task.finally(() => this._pendingChunks.delete(task));
    });
    this._recorder.addEventListener("error", (event) => {
      this.onError(event.error || new Error("ошибка MediaRecorder"));
    });

    // 7. Цикл отрисовки: по кадрам источника, а не по таймеру — меньше нагрузка
    //    и нет повторных перерисовок, когда на экране ничего не меняется.
    const interval = Math.max(16, Math.round(1000 / Math.min(60, Math.max(5, fps))));
    this._startDrawLoop(interval);

    this._recorder.start(1000);
    mark("MediaRecorder.start");
    this.active = true;
    this.paused = false;
    this.startedAt = Date.now();
    this.pausedMs = 0;

    videoTrack.addEventListener("ended", () => {
      if (this.active) this.onError(new Error("захват экрана остановлен извне"));
    });

    return {
      mimeType: this.mimeType,
      width: cw,
      height: ch,
      bitrate,
      warnings,
      sourceSize: { width: vw, height: vh },
    };
  }

  /**
   * Запись только звука: системный loopback + микрофон, без canvas.
   * Промежуточный контейнер — тот, что даёт MediaRecorder (обычно WebM/Opus),
   * финальный формат собирает ffmpeg в главном процессе.
   */
  async startAudio({
    target,
    mic = false,
    systemAudio = true,
    micDevice = "",
    micVolume = 100,
    systemVolume = 100,
    micCleanup = true,
    systemDevice = "",
  }) {
    if (this.active) throw new Error("запись уже идёт");

    const wantLoopback = Boolean(systemAudio) && !systemDevice;
    const warnings = [];
    const mimeType = [
      'audio/webm;codecs="opus"',
      "audio/webm",
      'audio/mp4;codecs="mp4a.40.2"',
      "audio/mp4",
    ].find((type) => {
      try {
        return MediaRecorder.isTypeSupported(type);
      } catch {
        return false;
      }
    });

    let systemTracks = [];
    if (wantLoopback && target?.kind === "screen") {
      this._display = await withTimeout(
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
        15000,
        "getDisplayMedia не ответил за 15 с",
      );
      systemTracks = this._display.getAudioTracks();
      if (!systemTracks.length) warnings.push("системный звук не отдан Chromium");
      // Видео нам не нужно, но дорожку держим до конца записи, иначе Chromium
      // закрывает весь захват вместе с ней.
    }

    const deviceTracks = await this._openSystemDevice(systemAudio && systemDevice, warnings);
    if (deviceTracks.length) systemTracks = deviceTracks;

    this._audioCtx = new AudioContext();
    if (this._audioCtx.state === "suspended") await this._audioCtx.resume();
    const dest = this._audioCtx.createMediaStreamDestination();
    this._gains = {};

    if (mic) {
      try {
        // Выбранный в настройках аудиовход: без deviceId берём системный.
        const micConstraints = {
          echoCancellation: micCleanup,
          noiseSuppression: micCleanup,
          autoGainControl: micCleanup,
        };
        if (micDevice) micConstraints.deviceId = { exact: micDevice };
        this._micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
        const micSource = this._audioCtx.createMediaStreamSource(this._micStream);
        this._connectWithGain("mic", micSource, dest, micVolume);
        this._meters.mic = this._meterFor(micSource);
      } catch (err) {
        warnings.push(`микрофон недоступен: ${err.name || err.message}`);
      }
    }
    if (systemTracks.length) {
      const sysSource = this._audioCtx.createMediaStreamSource(new MediaStream(systemTracks));
      this._connectWithGain("system", sysSource, dest, systemVolume);
      this._meters.system = this._meterFor(sysSource);
    }
    if (!mic && !systemTracks.length) throw new Error("нечего записывать: включите микрофон или системный звук");

    this._composite = dest.stream;
    this._recorder = new MediaRecorder(this._composite, mimeType ? { mimeType } : undefined);
    this.mimeType = this._recorder.mimeType;
    this.chunks = 0;
    this.bytes = 0;
    // Те же счётчики, что в видео-ветке: stop() ждёт чтение последнего блоба,
    // и без набора задач запись «только звук» падала на остановке
    // (this._pendingChunks is not iterable), оставляя захват занятым.
    this._chunkLog = [];
    this._pendingChunks = new Set();
    this._recorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size === 0) return;
      this.chunks += 1;
      const task = (async () => {
        const buffer = await event.data.arrayBuffer();
        this.bytes += buffer.byteLength;
        this._chunkLog.push({ at: Math.round(this.elapsedMs), size: buffer.byteLength });
        this.onChunk(buffer);
      })();
      this._pendingChunks.add(task);
      task.finally(() => this._pendingChunks.delete(task));
    });
    this._recorder.addEventListener("error", (event) => {
      this.onError(event.error || new Error("ошибка MediaRecorder"));
    });

    this._recorder.start(1000);
    this.active = true;
    this.paused = false;
    this.startedAt = Date.now();
    this.pausedMs = 0;

    return {
      mimeType: this.mimeType,
      width: 0,
      height: 0,
      bitrate: 0,
      warnings,
      sourceSize: { width: 0, height: 0 },
    };
  }

  /**
   * Позиция курсора приходит из main в DIP виртуального рабочего стола.
   * Переводим её в пиксели исходного кадра, из которого уже вычитается кроп.
   */
  setCursor(point) {
    if (!this._cursorAllowed) return;
    if (!point || !this._displayInfo || !this._sourceSize) return;
    const bounds = this._displayInfo.bounds;
    if (!bounds || !bounds.width) return;
    const scale = this._sourceSize.width / bounds.width;
    const x = (Number(point.x) - bounds.x) * scale;
    const y = (Number(point.y) - bounds.y) * scale;
    this._cursor = {
      x: Math.max(0, Math.min(this._sourceSize.width, x)),
      y: Math.max(0, Math.min(this._sourceSize.height, y)),
    };
  }

  /** Ждёт первый настоящий кадр видеопотока (до 1.5 с). */
  async _waitFirstFrame() {
    const video = this._video;
    if (!video) return;
    if (typeof video.requestVideoFrameCallback === "function") {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        try {
          video.requestVideoFrameCallback(() => {
            clearTimeout(timer);
            finish();
          });
        } catch {
          clearTimeout(timer);
          finish();
        }
      });
    } else {
      await sleep(150);
    }
  }

  _draw() {
    if (!this._ctx || !this._video || this.paused) return;
    const { cx, cy, cw, ch } = this._geom;
    const live =
      this._video.readyState >= 2 && this._video.videoWidth > 1 && this._video.videoHeight > 1;
    this._drawCount = (this._drawCount || 0) + 1;
    if (live) {
      try {
        this._ctx.drawImage(this._video, cx, cy, cw, ch, 0, 0, cw, ch);
      } catch (err) {
        this._drawErr = `${err && err.name}: ${err && err.message} · readyState=${this._video.readyState}`;
        return;
      }
    } else if (this._placeholder) {
      // Живого кадра ещё нет: держим на холсте снимок области. Перерисовка
      // каждый тик нужна, чтобы canvas.captureStream отдавал кадры и запись
      // шла с первой секунды, а не с момента первого кадра WGC.
      this._ctx.drawImage(this._placeholder, 0, 0, cw, ch);
    } else {
      return;
    }
    this._drawOk = (this._drawOk || 0) + 1;

    if (this._webcamVideo && this._webcamVideo.readyState >= 2) {
      const pipW = Math.round(ch * 0.24);
      const pipH = Math.round((pipW * 3) / 4);
      const pad = Math.round(ch * 0.035);
      const x = cw - pipW - pad;
      const y = ch - pipH - pad;
      this._ctx.save();
      this._ctx.beginPath();
      this._ctx.rect(x, y, pipW, pipH);
      this._ctx.clip();
      this._ctx.drawImage(this._webcamVideo, x, y, pipW, pipH);
      this._ctx.restore();
      this._ctx.strokeStyle = "rgba(110, 231, 168, 0.9)";
      this._ctx.lineWidth = Math.max(2, Math.round(ch * 0.004));
      this._ctx.strokeRect(x, y, pipW, pipH);
    }

    if (this._cursor) {
      const x = this._cursor.x - this._geom.cx;
      const y = this._cursor.y - this._geom.cy;
      if (x >= -40 && y >= -40 && x <= cw + 40 && y <= ch + 40) {
        const radius = Math.max(9, Math.round(ch * 0.018));
        this._ctx.save();
        this._ctx.beginPath();
        this._ctx.arc(x, y, radius, 0, Math.PI * 2);
        this._ctx.strokeStyle = "rgba(110, 231, 168, 0.95)";
        this._ctx.lineWidth = Math.max(2, Math.round(ch * 0.003));
        this._ctx.stroke();
        this._ctx.beginPath();
        this._ctx.arc(x, y, radius * 1.9, 0, Math.PI * 2);
        this._ctx.strokeStyle = "rgba(110, 231, 168, 0.28)";
        this._ctx.lineWidth = Math.max(1, Math.round(ch * 0.002));
        this._ctx.stroke();
        this._ctx.restore();
      }
    }
  }

  /**
   * Кадры рисуем по таймеру, а не по кадру источника.
   *
   * Раньше цикл висел на requestVideoFrameCallback: статичный экран не даёт
   * новых кадров в getDisplayMedia, колбэк молчит, canvas не перерисовывается,
   * canvas.captureStream ничего не отдаёт — и MediaRecorder пишет видео длиной
   * в доли секунды вместо всей записи (6 секунд записи → 0.6 с в файле).
   * Постоянная перерисовка держит реальную длительность и постоянный FPS.
   */
  _startDrawLoop(interval) {
    this._draw();
    this._drawTimer = setInterval(() => this._draw(), interval);
  }

  _stopDrawLoop() {
    if (this._drawTimer) {
      clearInterval(this._drawTimer);
      this._drawTimer = null;
    }
    if (this._rvfcHandle && this._video && typeof this._video.cancelVideoFrameCallback === "function") {
      try {
        this._video.cancelVideoFrameCallback(this._rvfcHandle);
      } catch {
        /* уже отменён */
      }
    }
    this._rvfcHandle = null;
  }

  pause() {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.pausedAt = Date.now();
    try {
      this._recorder.pause();
    } catch {
      /* уже на паузе */
    }
  }

  resume() {
    if (!this.active || !this.paused) return;
    this.pausedMs += Date.now() - this.pausedAt;
    this.pausedAt = 0;
    this.paused = false;
    try {
      this._recorder.resume();
    } catch {
      /* уже идёт */
    }
  }

  /**
   * Звук компьютера с выбранного входа (интерфейс, виртуальный кабель, «петля» в
   * драйвере). Без обработки: это не голос, эхо- и шумоподавление его испортили бы.
   * Пустой deviceId — ничего не открываем; ошибка — предупреждение, запись идёт без него.
   */
  async _openSystemDevice(deviceId, warnings) {
    if (!deviceId) return [];
    try {
      this._sysDeviceStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
      return this._sysDeviceStream.getAudioTracks();
    } catch (err) {
      warnings.push(`выбранный источник звука компьютера недоступен: ${err.name || err.message}`);
      return [];
    }
  }

  /** Источник → регулятор громкости → общая дорожка. volume — проценты, 100 = без изменений. */
  _connectWithGain(kind, sourceNode, dest, volume) {
    const gain = this._audioCtx.createGain();
    gain.gain.value = Math.max(0, Number(volume) || 0) / 100;
    sourceNode.connect(gain);
    gain.connect(dest);
    this._gains[kind] = gain;
  }

  /** Меняет баланс на лету, пока идёт запись: { mic?, system? } в процентах. */
  setGains({ mic, system } = {}) {
    const apply = (kind, percent) => {
      const gain = this._gains?.[kind];
      if (gain && Number.isFinite(percent)) {
        gain.gain.setTargetAtTime(Math.max(0, percent) / 100, this._audioCtx.currentTime, 0.03);
      }
    };
    apply("mic", Number(mic));
    apply("system", Number(system));
  }

  /**
   * Слушающий анализатор для дорожки. Узел только измеряет: звук в него
   * попадает, но дальше не идёт — сведение делает dest.
   */
  _meterFor(sourceNode) {
    const analyser = this._audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    sourceNode.connect(analyser);
    return analyser;
  }

  /**
   * Текущий уровень дорожки (RMS, 0…1) для полос в интерфейсе.
   * kind: "mic" | "system". Нет дорожки — 0.
   */
  level(kind = "system") {
    const analyser = this._meters[kind];
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const sample = (data[i] - 128) / 128;
      sum += sample * sample;
    }
    return Math.sqrt(sum / data.length);
  }

  async stop() {
    if (!this.active) return { mimeType: this.mimeType, chunks: this.chunks };
    this.active = false;
    this._stopDrawLoop();

    const recorder = this._recorder;
    const stopped = new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") return resolve();
      recorder.addEventListener("stop", () => resolve(), { once: true });
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });
    await Promise.race([stopped, sleep(3000)]);

    // Ждём не «примерно 350 мс», а все незавершённые чтения блобов: последний
    // чанк отдаётся при остановке и бывает на несколько секунд записи. Из-за
    // этого файл выходил короче сессии (16.8 с записи → 11.6 с в файле).
    await Promise.allSettled([...(this._pendingChunks || [])]);
    await sleep(60);

    this._teardown();
    return { mimeType: this.mimeType, chunks: this.chunks, bytes: this.bytes };
  }

  async cancel() {
    this.active = false;
    this._stopDrawLoop();
    try {
      if (this._recorder && this._recorder.state !== "inactive") this._recorder.stop();
    } catch {
      /* ignore */
    }
    this._teardown();
  }

  _teardown() {
    for (const stream of [this._display, this._loopback, this._micStream, this._sysDeviceStream, this._webcamStream]) {
      try {
        stream?.getTracks().forEach((track) => track.stop());
      } catch {
        /* ignore */
      }
    }
    if (this._audioCtx) {
      this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }
    this._meters.mic = null;
    this._meters.system = null;
    this._display = null;
    this._loopback = null;
    this._micStream = null;
    this._sysDeviceStream = null;
    this._webcamStream = null;
    this._webcamVideo = null;
    this._recorder = null;
    this._composite = null;
    this._canvas = null;
    this._ctx = null;
    this._video = null;
    this._geom = null;
    this._rvfcHandle = null;
    this._placeholder = null;
  }
}

/** Снимок выделенной области экрана — для «Ножниц». */
export async function grabRegion(region) {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    await video.play();
    await waitUntil(() => video.videoWidth > 1, 4000).catch(() => {});
    await waitForFirstFrame(video);

    const scale = video.videoWidth / (region.displaySize?.width || video.videoWidth);
    const sx = Math.max(0, Math.round(region.x * scale));
    const sy = Math.max(0, Math.round(region.y * scale));
    const sw = Math.max(2, Math.min(video.videoWidth - sx, Math.round(region.width * scale)));
    const sh = Math.max(2, Math.min(video.videoHeight - sy, Math.round(region.height * scale)));

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL("image/png");
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

/** Ждём реальный кадр, иначе кроп получится чёрным. */
async function waitForFirstFrame(video) {
  if (typeof video.requestVideoFrameCallback === "function") {
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(finish, 1500);
      try {
        video.requestVideoFrameCallback(() => {
          clearTimeout(timer);
          finish();
        });
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  } else {
    await sleep(150);
  }
}

/** Один кадр с источника — для скриншота. */
export async function grabStill(target, ext = "image/png") {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = new MediaStream([track]);
    await video.play();
    await waitUntil(() => video.videoWidth > 1, 4000).catch(() => {});
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    // Качество 1.0: для PNG аргумент игнорируется, для JPEG даёт максимум
    // вместо дефолтных 0.92 — снимки не должны мылиться.
    const dataUrl = canvas.toDataURL(ext, 1);
    return dataUrl;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function waitUntil(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout"));
      }
    }, 50);
  });
}

function waitFor(emitter, event, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      emitter.removeEventListener(event, finish);
      resolve(true);
    };
    emitter.addEventListener(event, finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
}
