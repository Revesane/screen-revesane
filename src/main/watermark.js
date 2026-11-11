"use strict";

/**
 * Водяной знак при перекоде: текст или PNG поверх кадра.
 *
 * Почему отдельный модуль: фильтр ffmpeg капризен к экранированию (двоеточия в
 * путях, кириллица, проценты в тексте), а нам нужно собирать его из настроек
 * один раз и одинаково для всех контейнеров. Текст пишется во временный файл
 * и подаётся через `textfile=` — так не нужно экранировать содержимое вообще.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const I18N = require("../i18n/i18n.js");

const POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right", "center"];
// Подписи позиций — ключи i18n: переводятся через I18N.t там, где их показывают.
const POSITION_LABELS = {
  "top-left": "слева сверху",
  "top-right": "справа сверху",
  "bottom-left": "слева снизу",
  "bottom-right": "справа снизу",
  center: "по центру",
};

/** Приводит разрозненные ключи настроек к одному описанию. */
function fromSettings(settings = {}) {
  const position = POSITIONS.includes(settings.watermarkPosition) ? settings.watermarkPosition : "bottom-right";
  return {
    enabled: Boolean(settings.watermarkOn),
    text: String(settings.watermarkText || "").trim(),
    image: String(settings.watermarkImage || "").trim(),
    position,
    size: Math.max(8, Math.min(400, Number(settings.watermarkSize) || 28)),
    opacity: Math.min(1, Math.max(0.05, Number(settings.watermarkOpacity ?? 0.85) || 0.85)),
    shadow: settings.watermarkShadow !== false,
    margin: Math.max(0, Math.min(400, Number(settings.watermarkMargin ?? 24))),
  };
}

/** Есть ли что накладывать (включено и задан текст или картинка). */
function isActive(watermark) {
  return Boolean(watermark?.enabled && (watermark.text || watermark.image));
}

/**
 * Куда ставить: возвращает фрагменты x/y для drawtext и overlay.
 * У drawtext размеры текста — `text_w`/`text_h`, у overlay — `w`/`h`.
 */
function positionExpr(watermark) {
  const m = watermark.margin;
  const map = {
    "top-left": { text: [`${m}`, `${m}`], overlay: [`${m}`, `${m}`] },
    "top-right": { text: [`w-text_w-${m}`, `${m}`], overlay: [`W-w-${m}`, `${m}`] },
    "bottom-left": { text: [`${m}`, `h-text_h-${m}`], overlay: [`${m}`, `H-h-${m}`] },
    "bottom-right": { text: [`w-text_w-${m}`, `h-text_h-${m}`], overlay: [`W-w-${m}`, `H-h-${m}`] },
    center: { text: [`(w-text_w)/2`, `(h-text_h)/2`], overlay: [`(W-w)/2`, `(H-h)/2`] },
  };
  return map[watermark.position] ?? map["bottom-right"];
}

/**
 * Путь в тексте фильтра. Двоеточие в `C:` — разделитель опций, и его надо
 * экранировать дважды: `\:` для разбора опций и второй `\` для разбора самого
 * графа. Одинарные кавычки здесь не помогают — ffmpeg разбирает значение
 * опции раньше, чем видит кавычку, и падает с «No option name near
 * '/WINDOWS/Fonts/…'» (проверено на ffmpeg 9.0). Заодно кавычки не годятся
 * и потому, что апостроф в пути сломал бы их.
 */
function filterPath(target) {
  return String(target).replace(/\\/g, "/").replace(/:/g, "\\\\:");
}

function fontPath() {
  const candidates = [
    path.join(process.env.WINDIR || "C:\\Windows", "Fonts", "segoeui.ttf"),
    path.join(process.env.WINDIR || "C:\\Windows", "Fonts", "arial.ttf"),
  ];
  return candidates.find((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

/**
 * Собирает план наложения. Возвращает либо `null` (нечего накладывать),
 * либо описание для convertContainer:
 *   mode "text"  → videoFilter (один -vf)
 *   mode "image" → extraInputs (-i wm.png) + filterComplex + maps
 * cleanup — временные файлы, которые надо удалить после ffmpeg.
 */
function plan(watermark) {
  if (!isActive(watermark)) return null;
  const pos = positionExpr(watermark);

  if (watermark.image) {
    const imagePath = watermark.image;
    const maybe = (() => {
      try {
        return fs.statSync(imagePath).isFile();
      } catch {
        return null;
      }
    })();
    if (!maybe) {
      // Картинки нет — не молчим, пусть вызывающий добавит предупреждение.
      return { error: I18N.t("файл водяного знака не найден: {0}", path.basename(imagePath)) };
    }
    const [x, y] = pos.overlay;
    const chain = [
      `[0:v]format=rgba[base]`,
      `[1:v]scale=${watermark.size}:-1,format=rgba,colorchannelmixer=aa=${watermark.opacity}[wmk]`,
      `[base][wmk]overlay=${x}:${y}:format=auto[vout]`,
    ].join(";");
    return {
      mode: "image",
      extraInputs: ["-i", imagePath],
      filterComplex: chain,
      maps: ["-map", "[vout]", "-map", "0:a?"],
      cleanup: [],
    };
  }

  const font = fontPath();
  if (!font) return { error: I18N.t("не найден системный шрифт для текста водяного знака") };

  const textFile = path.join(os.tmpdir(), `screen-revesane-wm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`);
  fs.writeFileSync(textFile, watermark.text, "utf8");

  const [x, y] = pos.text;
  const parts = [
    // expansion=none: без него drawtext ищет в тексте %{…}/%X и падает на
    // «Stray % near» у любого процента в подписи.
    "drawtext=expansion=none",
    `fontfile=${filterPath(font)}`,
    `textfile=${filterPath(textFile)}`,
    `fontcolor=white@${watermark.opacity}`,
    `fontsize=${watermark.size}`,
    `x=${x}`,
    `y=${y}`,
  ];
  if (watermark.shadow) parts.push("shadowcolor=black@0.6", "shadowx=2", "shadowy=2");
  return {
    mode: "text",
    videoFilter: parts.join(":"),
    extraInputs: [],
    cleanup: [textFile],
  };
}

/** Убирает временные файлы плана (после ffmpeg). */
async function cleanup(watermarkPlan) {
  for (const file of watermarkPlan?.cleanup ?? []) {
    await fsp.unlink(file).catch(() => {});
  }
}

module.exports = { POSITIONS, POSITION_LABELS, fromSettings, isActive, plan, cleanup };
