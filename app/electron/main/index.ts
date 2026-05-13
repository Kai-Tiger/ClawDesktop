import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { OpenClawPaths } from './paths';
import { SessionService } from './session-service';
import { GroupService } from './group-service';
import { GatewayService } from './gateway-service';
import { WorkerService } from './worker-service';
import { TelegramService } from './telegram-service';
import { ConfigService } from './config-service';
import { ChatService } from './chat-service';
import { CoordinatorService } from './coordinator-service';
import { MobileBridgeService } from './mobile-bridge-service';
import { registerIpcHandlers } from './ipc-handlers';

const paths = new OpenClawPaths();
const sessions = new SessionService(paths);
const groups = new GroupService(paths);
const workers = new WorkerService(paths, sessions);
const gateway = new GatewayService(paths, () => workers.listWorkers());
const telegram = new TelegramService(paths, workers);
const config = new ConfigService(paths, sessions, gateway);
const chat = new ChatService(paths, gateway, sessions, workers, (workerId) => config.getWorkerConfiguredModelFull(workerId), () => config.getModel());
const coordinator = new CoordinatorService(paths, config);
const mobileBridge = new MobileBridgeService(workers, chat, groups, coordinator, paths);
gateway.addWorkerEventListener((event) => mobileBridge.broadcast(event));

async function bootstrap() {
  const stateDir = path.join(paths.userRuntimeRoot, 'state');
  const logsDir = path.join(paths.userRuntimeRoot, 'logs');
  const homeStateDir = path.join(paths.userOpenClawHome, 'state');
  const homeLogsDir = path.join(paths.userOpenClawHome, 'logs');
  const telegramHomeStateDir = path.join(paths.userTelegramOpenClawHome, 'state');
  const telegramHomeLogsDir = path.join(paths.userTelegramOpenClawHome, 'logs');
  const versionFile = path.join(stateDir, 'runtime-version.json');

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(homeStateDir, { recursive: true });
  fs.mkdirSync(homeLogsDir, { recursive: true });
  fs.mkdirSync(telegramHomeStateDir, { recursive: true });
  fs.mkdirSync(telegramHomeLogsDir, { recursive: true });
  fs.mkdirSync(paths.userWorkspace, { recursive: true });

  telegram.maybeMigrateTelegramConfigToPrimaryHome();

  paths.ensurePathExists(paths.resourcesRuntime, 'runtime 根目录');
  paths.ensureExecutable(paths.embeddedNodePath);
  paths.ensurePathExists(paths.openclawCliPath, 'OpenClaw CLI 入口');

  let installedVersion = '';
  if (fs.existsSync(versionFile)) {
    try {
      installedVersion = JSON.parse(fs.readFileSync(versionFile, 'utf8')).version || '';
    } catch {
      installedVersion = '';
    }
  }

  const configBatch: Array<{ path: string; value: unknown }> = [
    { path: 'gateway.mode', value: 'local' },
    { path: 'gateway.auth.mode', value: 'none' },
    { path: 'gateway.http.endpoints.chatCompletions.enabled', value: true },
    { path: 'skills.load.extraDirs', value: [] },
  ];
  if (telegram.hasTelegramChannelConfigured()) {
    configBatch.push({ path: 'plugins.entries.telegram.enabled', value: true });
  }
  await paths.runOpenClaw([
    'config', 'set', '--batch-json',
    JSON.stringify(configBatch)
  ]);

  const workerList = workers.listWorkers();
  workers.ensureSubagentToolsDenied(workerList.map((w) => w.id));
  await Promise.all(workerList.map((w) => workers.bootstrapWorkerAgent(w).catch((err) => {
    console.error(`[bootstrap] worker agent ${w.id} failed:`, err);
  })));

  if (installedVersion !== paths.runtimeVersion) {
    fs.writeFileSync(
      versionFile,
      JSON.stringify(
        {
          version: paths.runtimeVersion,
          initializedAt: new Date().toISOString(),
          packaged: app.isPackaged
        },
        null,
        2
      ),
      'utf8'
    );
  }
}

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js')
    }
  });
  mainWindow = win;

  if (!app.isPackaged) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.resolve(__dirname, '../renderer/index.html'));
  }
}

app.on('before-quit', () => { gateway.stopGatewayWsClient(); gateway.stopGateway(); mobileBridge.stop(); });

app.whenReady().then(async () => {
  try {
    await bootstrap();
  } catch (error) {
    console.error('[bootstrap failed]', error);
  }
  gateway.startGateway()
    .then(() => { setTimeout(() => gateway.startGatewayWsClient(), 3000); })
    .catch((err) => console.error('[auto-start gateway failed]', err));
  mobileBridge.start().catch((err) => console.error('[mobile-bridge start failed]', err));
  createWindow();

  registerIpcHandlers({
    gateway, config, workers, chat, telegram, groups, sessions, coordinator, mobileBridge,
    mainWindowRef: { current: mainWindow },
  });
});
