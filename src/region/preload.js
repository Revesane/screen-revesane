"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("regionApi", {
  done: (rect) => ipcRenderer.send("region:done", rect),
  // Замороженный снимок экрана, который показывается под рамкой.
  onBackdrop: (handler) => ipcRenderer.on("region:backdrop", (_e, dataUrl) => handler(dataUrl)),
  // Повторное нажатие горячей клавиши: подтвердить уже нарисованную рамку.
  onConfirm: (handler) => ipcRenderer.on("region:confirm", () => handler()),
  onLang: (handler) => ipcRenderer.on("lang:changed", (_e, lang) => handler(lang)),
  // Снимок текущей рамки, окно выделения при этом не закрывается.
  snap: (rect, copy) => ipcRenderer.invoke("region:snap", { rect, copy }),
  // Снять экран как есть (с рамкой видео) перед выделением снимка.
  snapBegin: () => ipcRenderer.invoke("region:snap-begin"),
  snapEnd: () => ipcRenderer.send("region:snap-end"),
  onSnapRequest: (handler) => ipcRenderer.on("region:snap-request", () => handler()),
});
