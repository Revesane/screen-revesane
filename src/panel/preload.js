"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("panelApi", {
  onStyle: (handler) => ipcRenderer.on("panel:style", (_e, style) => handler(style)),
  onState: (handler) => ipcRenderer.on("panel:state", (_e, state) => handler(state)),
  command: (action) => ipcRenderer.send("panel:command", action),
});
