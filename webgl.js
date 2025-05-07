const { app, BrowserWindow, ipcMain } = require('electron');

app.commandLine.appendSwitch('enable-features','SharedArrayBuffer');
app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 700,
        height: 475,
        webPreferences: {
            sandbox: false,
            nodeIntegration: true,
            contextIsolation: false,
            nodeIntegrationInWorker: true
        }
    });

    ipcMain.on('error', () => { win.webContents.openDevTools({ mode: 'detach' }); });
    win.loadFile('gl_worker.html');
});

app.on('window-all-closed', () => app.quit());
app.on('gpu-info-update', () => console.log(app.getGPUFeatureStatus()));