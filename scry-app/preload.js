const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("host", {
    config: () => ipcRenderer.invoke("config"),
    qr: (text, opts) => ipcRenderer.invoke("qr", text, opts),
    copyText: (text) => ipcRenderer.invoke("copy-text", text),
    copyImage: (dataUrl) => ipcRenderer.invoke("copy-image", dataUrl),
    openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
