"use strict";

/**
 * Единый файловый лог приложения.
 *
 * Формат строки: `ЧЧ:ММ:СС.мс [LVL][модуль] сообщение` — по логу видна полная
 * хронология без догадок. Файл на сутки: `%APPDATA%\Screen Revesane\logs\screen-revesane-ГГГГ-ММ-ДД.log`,
 * хранится 7 дней.
 *
 * Запись не блокирует main: строки складываются в очередь промисов, а ошибки
 * записи молча проглатываются — лог не должен ронять запись.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const KEEP_DAYS = 7;
const state = { dir: null, file: null, queue: Promise.resolve(), inited: false };

const pad = (n, width = 2) => String(n).padStart(width, "0");

function stamp(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function dayName(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fileFor(date = new Date()) {
  return path.join(state.dir ?? "", `screen-revesane-${dayName(date)}.log`);
}

/** Удаляет лог-файлы старше KEEP_DAYS суток (по имени, без чтения содержимого). */
function rotate() {
  if (!state.dir) return;
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let names = [];
  try {
    names = fs.readdirSync(state.dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^screen-revesane-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const full = path.join(state.dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      /* файл занят или уже удалён */
    }
  }
}

function init(userDataDir) {
  state.dir = path.join(userDataDir, "logs");
  try {
    fs.mkdirSync(state.dir, { recursive: true });
  } catch {
    /* без лога тоже живём */
  }
  state.inited = true;
  state.file = fileFor();
  rotate();
  return state.dir;
}

function write(level, module, message) {
  const line = `${stamp()} [${level}][${module}] ${message}\n`;
  try {
    process.stdout.write(line);
  } catch {
    /* в упакованной сборке stdout может отсутствовать */
  }
  if (!state.inited) return;
  const target = fileFor();
  state.file = target;
  state.queue = state.queue
    .then(() => fsp.appendFile(target, line, "utf8"))
    .catch(() => {
      /* диск занят/нет прав — лог не критичен */
    });
}

const log = {
  init,
  file: () => state.file,
  dir: () => state.dir,
  info: (module, message) => write("INF", module, message),
  warn: (module, message) => write("WRN", module, message),
  error: (module, message) => write("ERR", module, message),
  debug: (module, message) => write("DBG", module, message),
  /** Последние n строк текущего файла — для экрана «Больше». */
  async tail(n = 80) {
    const target = fileFor();
    try {
      const text = await fsp.readFile(target, "utf8");
      return text.split("\n").filter(Boolean).slice(-n);
    } catch {
      return [];
    }
  },
};

module.exports = log;
