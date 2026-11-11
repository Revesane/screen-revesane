"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("frameApi", {
  onState: (handler) => ipcRenderer.on("frame:state", (_e, state) => handler(state)),
});
