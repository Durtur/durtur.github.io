const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage } = require("electron");
const path = require("path");
const QRCode = require("qrcode");

// Where viewers open the share. Override with SHARE_URL for local testing,
// e.g. SHARE_URL=http://localhost:8080/share/ npm start
const SHARE_URL = process.env.SHARE_URL || "https://www.ogreforge.me/share/";

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 860,
        minHeight: 560,
        backgroundColor: "#0d0f14",
        title: "Ogreforge Share",
        icon: path.join(__dirname, "..", "img", "gear-hammer.png"),
        titleBarStyle: "hidden",
        titleBarOverlay: process.platform === "darwin" ? true : {
            color: "#13161d",
            symbolColor: "#e8eaf0",
            height: 48,
        },
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    win.loadFile(path.join(__dirname, "src", "index.html"));

    // Open any external links in the user's browser, never inside the app.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
        if (!url.startsWith("file:")) {
            e.preventDefault();
            shell.openExternal(url);
        }
    });
}

ipcMain.handle("config", () => ({ shareUrl: SHARE_URL, platform: process.platform }));

ipcMain.handle("qr", (_e, text, opts = {}) =>
    QRCode.toDataURL(String(text), {
        errorCorrectionLevel: "M",
        margin: 1,
        width: opts.width || 360,
        color: { dark: "#0d0f14", light: "#ffffff" },
    })
);

ipcMain.handle("copy-text", (_e, text) => { clipboard.writeText(String(text)); return true; });

ipcMain.handle("copy-image", (_e, dataUrl) => {
    clipboard.writeImage(nativeImage.createFromDataURL(String(dataUrl)));
    return true;
});

ipcMain.handle("open-external", (_e, url) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
    return false;
});

app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
