"use strict";

/**
 * Автоматическая доставка ffmpeg и ffprobe.
 *
 * Зачем: без ffmpeg программа сохраняет только нативные форматы Chromium
 * (MP4/WebM), а MKV/GIF/склейка/обрезка недоступны. Просить пользователя
 * «поставь ffmpeg в PATH» не хочется, поэтому при первом запуске, если своего
 * ffmpeg нет, сборка скачивается в `%APPDATA%\Screen Revesane\tools\bin` —
 * один раз, без прав администратора. Если ffmpeg есть в PATH — ничего не
 * качаем, свой приоритетнее.
 *
 * Источники по порядку: GitHub (сборки BtbN), затем gyan.dev (essentials).
 * Из архива нужны только bin/ffmpeg.exe и bin/ffprobe.exe: распаковываем во
 * временный каталог через PowerShell (Expand-Archive есть в любой Windows
 * 10/11) и копируем два файла. Распакованное и архив удаляем, остаются
 * только сами исполняемые файлы (~120 МБ).
 */

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SOURCES = [
  {
    id: "btbn",
    label: "GitHub (BtbN)",
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip",
  },
  {
    id: "gyan",
    label: "gyan.dev",
    url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
  },
];

/** Час на загрузку: медленный интернет не должен обрывать скачивание. */
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────── macOS
//
// Готовых zip-сборок ffmpeg для macOS нет, поэтому бинарники берутся
// по отдельности: ffmpeg — из релизов проекта ffmpeg-static (GitHub),
// ffprobe — из npm-пакета ffprobe-static (реестр npm стабилен, сборки
// лежат в package/bin/darwin/<arch>). Оба — статические, ничего ставить
// не нужно; бинарники копируются в tools/bin и помечаются исполняемыми.

const MAC_FFPROBE_REGISTRY = "https://registry.npmjs.org/ffprobe-static/latest";

function macArch() {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function macFfmpegUrl() {
  return `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-darwin-${macArch()}`;
}

/** Распаковка .tgz штатным tar (в macOS он есть из коробки). */
function extractTar(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `tar завершился с кодом ${code}`));
    });
  });
}

/** Приводит скачанные файлы к рабочему виду: права на исполнение. */
async function installExecutable(from, to) {
  await fsp.copyFile(from, to);
  await fsp.chmod(to, 0o755).catch(() => {});
}

/** Исполняемый файл рабочий: запускается и отвечает на `-version`. */
function executableWorks(file) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(file, ["-hide_banner", "-version"], { windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      resolve(code === 0 && /(ffmpeg|ffprobe) version/i.test(out));
    });
  });
}

/** Распаковка zip штатным PowerShell: без сторонних зависимостей. */
function expandArchive(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    // Одинарные кавычки внутри пути удваиваем — правила литералов PowerShell.
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const script = `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destDir)} -Force`;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Expand-Archive завершился с кодом ${code}`));
    });
  });
}

/** Ищет bin/<name> внутри распакованного архива; запасной вариант — любой <name>. */
async function findTool(root, name) {
  let found = null;
  let fallback = null;
  const walk = async (dir, depth) => {
    if ((found && fallback) || depth > 5) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found && fallback) return;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
        if (/(^|[\\/])bin$/i.test(dir)) found = full;
        else fallback ??= full;
      } else if (entry.isDirectory()) {
        await walk(full, depth + 1);
      }
    }
  };
  await walk(root, 0);
  return found ?? fallback;
}

/**
 * Скачивание по умолчанию — через global fetch (Node). В main-процессе
 * Electron вместо него подставляется net.fetch: тот работает на сетевом
 * стеке Chromium, то есть уважает системный прокси и работает там же, где
 * браузер. Тело пишется потоково, с прогрессом по Content-Length.
 */
function makeDownloader(fetchFn) {
  return async function download({ url, destPath, onProgress }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetchFn(url, { redirect: "follow", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const total = Number(response.headers?.get?.("content-length")) || 0;
      if (!response.body) throw new Error("сервер не отдал тело ответа");
      const reader = response.body.getReader();
      const handle = await fsp.open(destPath, "w");
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await handle.write(value);
          received += value.byteLength;
          if (total > 0) onProgress?.(Math.min(99, Math.round((received / total) * 100)));
        }
      } finally {
        await handle.close();
        reader.releaseLock?.();
      }
      onProgress?.(100);
      return received;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * macOS: ffmpeg — готовый бинарник из ffmpeg-static, ffprobe — из npm-пакета
 * ffprobe-static (сначала реестр даёт адрес tarball, затем tar распаковывает).
 */
async function ensureFfmpegMac({ toolsDir, havePath = false, onEvent = () => {}, fetch = null, download = null } = {}) {
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      /* обработчик не должен ронять загрузку */
    }
  };
  const fetchFn = fetch ?? globalThis.fetch;
  const downloadTo = download ?? makeDownloader(fetchFn);

  if (havePath) {
    return { ok: true, skipped: true, source: "path" };
  }

  const binDir = path.join(toolsDir, "bin");
  const managedFfmpeg = path.join(binDir, "ffmpeg");
  const managedFfprobe = path.join(binDir, "ffprobe");

  if (
    (await executableWorks(managedFfmpeg).catch(() => false)) &&
    (await executableWorks(managedFfprobe).catch(() => false))
  ) {
    emit({ phase: "ready", ffmpegPath: managedFfmpeg, ffprobePath: managedFfprobe, source: "кэш" });
    return { ok: true, cached: true, ffmpegPath: managedFfmpeg, ffprobePath: managedFfprobe };
  }

  emit({ phase: "start" });
  await fsp.mkdir(binDir, { recursive: true }).catch(() => {});
  const tempDir = path.join(os.tmpdir(), `screen-revesane-ffmpeg-${Date.now()}`);

  try {
    await fsp.mkdir(tempDir, { recursive: true });

    // 1. ffmpeg: готовый бинарник из релизов ffmpeg-static.
    emit({ phase: "download", source: "ffmpeg-static" });
    const ffmpegTmp = path.join(tempDir, "ffmpeg");
    await downloadTo({
      url: macFfmpegUrl(),
      destPath: ffmpegTmp,
      onProgress: (percent) => emit({ phase: "progress", percent, source: "ffmpeg" }),
    });
    await installExecutable(ffmpegTmp, managedFfmpeg);
    if (!(await executableWorks(managedFfmpeg).catch(() => false))) {
      throw new Error("скачанный ffmpeg не запустился на этой системе");
    }

    // 2. ffprobe: реестр npm → tarball → tar → bin/darwin/<arch>/ffprobe.
    emit({ phase: "download", source: "ffprobe-static" });
    const metaResponse = await fetchFn(MAC_FFPROBE_REGISTRY, {});
    if (!metaResponse.ok) throw new Error(`npm registry ответил ${metaResponse.status}`);
    const meta = await metaResponse.json();
    const tarballUrl = meta?.dist?.tarball;
    if (!tarballUrl) throw new Error("npm registry не отдал адрес пакета");
    const tgzPath = path.join(tempDir, "ffprobe.tgz");
    await downloadTo({
      url: tarballUrl,
      destPath: tgzPath,
      onProgress: (percent) => emit({ phase: "progress", percent, source: "ffprobe" }),
    });
    const unpackDir = path.join(tempDir, "ffprobe-pkg");
    await fsp.mkdir(unpackDir, { recursive: true });
    await extractTar(tgzPath, unpackDir);
    const probe = await findTool(unpackDir, "ffprobe");
    if (!probe) throw new Error("в пакете ffprobe-static нет bin/darwin/<arch>/ffprobe");
    await installExecutable(probe, managedFfprobe);
    if (!(await executableWorks(managedFfprobe).catch(() => false))) {
      throw new Error("скачанный ffprobe не запустился на этой системе");
    }

    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    emit({ phase: "ready", ffmpegPath: managedFfmpeg, ffprobePath: managedFfprobe, source: "ffmpeg-static" });
    return { ok: true, ffmpegPath: managedFfmpeg, ffprobePath: managedFfprobe };
  } catch (err) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    emit({ phase: "failed", error: String(err?.message || err) });
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Гарантирует наличие ffmpeg и ffprobe.
 *
 * Порядок: свой ffmpeg в PATH (havePath) → скачанная копия в toolsDir →
 * скачивание. События через onEvent: start / progress / extract / retry /
 * ready / failed — их слушают лог и интерфейс.
 *
 * Опции: `fetch` — своя fetch-функция (main подставляет net.fetch),
 * `download` — целиком своя функция скачивания для тестов.
 */
async function ensureFfmpeg(options = {}) {
  if (process.platform === "darwin") return ensureFfmpegMac(options);
  return ensureFfmpegWindows(options);
}

async function ensureFfmpegWindows({
  toolsDir,
  havePath = false,
  onEvent = () => {},
  fetch = null,
  download = null,
} = {}) {
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      /* обработчик не должен ронять загрузку */
    }
  };

  if (havePath) {
    return { ok: true, skipped: true, source: "path" };
  }

  const binDir = path.join(toolsDir, "bin");
  const managedFfmpeg = path.join(binDir, "ffmpeg.exe");
  const managedFfprobe = path.join(binDir, "ffprobe.exe");

  // Копия уже скачана ранее — скачивание не нужно вовсе.
  if (
    (await executableWorks(managedFfmpeg).catch(() => false)) &&
    (await executableWorks(managedFfprobe).catch(() => false))
  ) {
    emit({ phase: "ready", ffmpegPath: managedFfmpeg, ffprobePath: managedFfprobe, source: "кэш" });
    return { ok: true, cached: true, ffmpegPath: managedFfmpeg, ffprobePath: managedFfprobe };
  }

  emit({ phase: "start" });
  await fsp.mkdir(binDir, { recursive: true }).catch(() => {});
  const tempDir = path.join(os.tmpdir(), `screen-revesane-ffmpeg-${Date.now()}`);
  const downloadTo = download ?? makeDownloader(fetch ?? globalThis.fetch);
  let lastError = null;

  for (const source of SOURCES) {
    const zipPath = path.join(tempDir, `${source.id}.zip`);
    try {
      await fsp.mkdir(tempDir, { recursive: true });
      emit({ phase: "download", source: source.label });
      await downloadTo({ url: source.url, destPath: zipPath, onProgress: (percent) => {
        emit({ phase: "progress", percent, source: source.label });
      } });
      emit({ phase: "extract", source: source.label });
      const unpackDir = path.join(tempDir, source.id);
      await expandArchive(zipPath, unpackDir);
      const ffmpeg = await findTool(unpackDir, "ffmpeg.exe");
      const ffprobe = await findTool(unpackDir, "ffprobe.exe");
      if (!ffmpeg || !ffprobe) {
        throw new Error("в архиве нет bin/ffmpeg.exe и bin/ffprobe.exe");
      }
      await fsp.copyFile(ffmpeg, managedFfmpeg);
      await fsp.copyFile(ffprobe, managedFfprobe);
      if (
        !(await executableWorks(managedFfmpeg).catch(() => false)) ||
        !(await executableWorks(managedFfprobe).catch(() => false))
      ) {
        throw new Error("скачанные файлы не запустились на этой системе");
      }
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      emit({ phase: "ready", ffmpegPath: managedFfmpeg, ffprobePath: managedFfprobe, source: source.label });
      return { ok: true, ffmpegPath: managedFfmpeg, ffprobePath: managedFfprobe };
    } catch (err) {
      lastError = err;
      emit({ phase: "retry", source: source.label, error: String(err?.message || err) });
      await fsp.rm(zipPath, { force: true }).catch(() => {});
    }
  }

  await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  emit({ phase: "failed", error: String(lastError?.message || lastError) });
  return { ok: false, error: String(lastError?.message || lastError) };
}

module.exports = { ensureFfmpeg };
