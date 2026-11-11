"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("regionApi", {
  done: (rect) => ipcRenderer.send("region:done", rect),
  // Замороженный снимок экрана, который показывается под рамкой.
  onBackdrop: (handler) => ipcRenderer.on("region:backdrop", (_e, dataUrl) => handler(dataUrl)),
  // Повторное нажатие горячей клавиши: подтвердить уже нарисованную рамку.
  onConfirm: (handler) => ipcRenderer.on("region:confirm", () => handler()),
  onLang: (handler) => ipcRenderer.on("lang:changed", (_e, lang) => handler(lang)),
});
