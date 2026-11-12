"use strict";

/**
 * Обновления: последний релиз берётся из GitHub Releases этого репозитория.
 * Проверка — один GET к api.github.com (без данных о пользователе, кроме
 * того, что видит любой сайт: IP и версия браузера Chromium). Скачивание —
 * установщик из того же релиза; если GitHub отдал контрольную сумму
 * (поле digest), файл сверяется с ней до запуска.
 *
 * Модуль не зависит от Electron: fetch и пути передаёт main, поэтому логику
 * сравнения версий и выбора файла можно проверить обычным node.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const REPO = "Revesane/screen-revesane";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** «v0.2.10» → [0, 2, 10]; мусор и пререлизные хвосты отбрасываются. */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || "").trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/** >0 — a новее b, 0 — равны, <0 — a старее. Неразобранная версия считается старой. */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return va ? 1 : vb ? -1 : 0;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

/** Файл установщика под эту систему из списка файлов релиза. */
function pickAsset(assets, platform = process.platform) {
  const list = Array.isArray(assets) ? assets : [];
  const test =
    platform === "win32"
      ? (name) => /setup.*\.exe$/i.test(name)
      : platform === "darwin"
        ? (name) => /\.dmg$/i.test(name)
        : () => false;
  const asset = list.find((item) => test(String(item?.name || "")));
  if (!asset) return null;
  return {
    name: String(asset.name),
    url: String(asset.browser_download_url || ""),
    size: Number(asset.size) || 0,
    // GitHub отдаёт «sha256:<hex>» для файлов, загруженных после 2025 года.
    sha256: /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ""))?.[1]?.toLowerCase() || null,
  };
}

/** Скачивать разрешено только из релизов этого репозитория. */
function isTrustedUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      parsed.pathname.startsWith(`/${REPO}/releases/`)
    );
  } catch {
    return false;
  }
}

/**
 * Проверить последний релиз.
 * @returns {Promise<{ok: boolean, available?: boolean, version?: string, current: string,
 *   notes?: string, page?: string, publishedAt?: string, asset?: object|null, error?: string}>}
 */
async function checkLatest({ fetch, current, platform = process.platform }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(LATEST_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, current, error: `HTTP ${response.status}` };
    const release = await response.json();
    if (release?.draft || release?.prerelease) return { ok: true, available: false, current };
    const version = String(release?.tag_name || "").replace(/^v/i, "");
    if (!parseVersion(version)) return { ok: false, current, error: "bad tag" };
    const page = isTrustedUrl(release?.html_url) ? release.html_url : RELEASES_PAGE;
    const asset = pickAsset(release?.assets, platform);
    return {
      ok: true,
      available: compareVersions(version, current) > 0,
      version,
      current,
      // Заметки к релизу — только для показа; обрезаем, чтобы не тащить простыню.
      notes: String(release?.body || "").slice(0, 2000),
      page,
      publishedAt: release?.published_at || null,
      asset: asset && isTrustedUrl(asset.url) ? asset : null,
    };
  } catch (err) {
    return { ok: false, current, error: err?.name === "AbortError" ? "timeout" : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Скачать установщик во временную папку с прогрессом и проверкой.
 * @returns {Promise<{ok: boolean, path?: string, verified?: boolean, error?: string}>}
 */
async function downloadAsset({ fetch, asset, dir, onProgress }) {
  if (!asset || !isTrustedUrl(asset.url)) return { ok: false, error: "untrusted url" };
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, path.basename(asset.name));
  const part = `${target}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const hash = crypto.createHash("sha256");
  let handle = null;
  try {
    const response = await fetch(asset.url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) return { ok: false, error: `HTTP ${response.status}` };
    const total = Number(response.headers?.get?.("content-length")) || asset.size || 0;
    handle = await fsp.open(part, "w");
    const reader = response.body.getReader();
    let received = 0;
    let lastPercent = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      await handle.write(value);
      received += value.byteLength;
      const percent = total ? Math.min(99, Math.floor((received / total) * 100)) : 0;
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress?.({ percent, received, total });
      }
    }
    await handle.close();
    handle = null;
    if (asset.size && received !== asset.size) {
      await fsp.unlink(part).catch(() => {});
      return { ok: false, error: `size mismatch ${received}/${asset.size}` };
    }
    const digest = hash.digest("hex");
    if (asset.sha256 && digest !== asset.sha256) {
      await fsp.unlink(part).catch(() => {});
      return { ok: false, error: "checksum mismatch" };
    }
    await fsp.rm(target, { force: true });
    await fsp.rename(part, target);
    onProgress?.({ percent: 100, received, total: received });
    return { ok: true, path: target, verified: Boolean(asset.sha256) };
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(part).catch(() => {});
    return { ok: false, error: err?.name === "AbortError" ? "timeout" : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Старые скачанные установщики больше не нужны. */
async function cleanDownloads(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const name of await fsp.readdir(dir)) await fsp.rm(path.join(dir, name), { force: true });
  } catch {
    /* не критично */
  }
}

module.exports = {
  REPO,
  RELEASES_PAGE,
  parseVersion,
  compareVersions,
  pickAsset,
  isTrustedUrl,
  checkLatest,
  downloadAsset,
  cleanDownloads,
};
