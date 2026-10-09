const { app, BrowserWindow, Menu } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
let server;
if (process.env.RELAY_USER_DATA)
  app.setPath("userData", process.env.RELAY_USER_DATA);
if (process.env.RELAY_SMOKE_TEST) app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    const { startServer } = await import(
      pathToFileURL(path.join(__dirname, "../legacy/server/index.js")).href
    );
    server = await startServer({
      port: 0,
      host: process.env.RELAY_HOST || "127.0.0.1",
      dataDir: path.join(app.getPath("userData"), "workspaces"),
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: "Relay", submenu: [{ role: "quit" }] },
        {
          label: "Edit",
          submenu: [
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "toggleDevTools" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { role: "togglefullscreen" },
          ],
        },
      ]),
    );
    const win = new BrowserWindow({
      show: !process.env.RELAY_SMOKE_TEST,
      width: 1520,
      height: 980,
      minWidth: 760,
      minHeight: 560,
      backgroundColor: "#1e1e1e",
      title: "Relay",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const origin = `http://127.0.0.1:${server.port}`;
    win.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    await win.loadURL(origin);
    if (process.env.RELAY_SMOKE_TEST) {
      console.log("Relay desktop window loaded successfully.");
      await server.close();
      server = null;
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => server?.flush());
