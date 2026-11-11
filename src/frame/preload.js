"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("frameApi", {
  onState: (handler) => ipcRenderer.on("frame:state", (_e, state) => handler(state)),
  onLang: (handler) => ipcRenderer.on("lang:changed", (_e, lang) => handler(lang)),
});
