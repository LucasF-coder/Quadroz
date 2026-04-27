const path = require('path');
const { spawn } = require('child_process');
const cron = require('node-cron');

let schedulerStarted = false;
let activeSyncChild = null;
let restartTimer = null;
let continuousModeEnabled = false;
let consecutiveFailures = 0;
let maxRestartDelay = 60_000;
const INITIAL_RESTART_DELAY = 10_000;
const MAX_RESTART_DELAY = 300_000;
let lastSyncState = {
  running: false,
  trigger: '',
  pid: null,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  error: ''
};

function readContinuousFlag() {
  const mode = String(process.env.SYNC_MODE || '').trim().toLowerCase();
  if (mode === 'continuous') return true;
  if (mode === 'daily') return false;
  return String(process.env.SYNC_CONTINUOUS || '1').trim() !== '0';
}

function clearRestartTimer() {
  if (!restartTimer) return;
  clearTimeout(restartTimer);
  restartTimer = null;
}

function scheduleContinuousRestart() {
  clearRestartTimer();
  if (consecutiveFailures >= 10) {
    // eslint-disable-next-line no-console
    console.log(`[sync] muchas falhas consecutivas (${consecutiveFailures}), pausando por ${maxRestartDelay / 1000}s`);
    if (maxRestartDelay < MAX_RESTART_DELAY) {
      maxRestartDelay = Math.min(maxRestartDelay * 2, MAX_RESTART_DELAY);
    }
  }
  const delay = maxRestartDelay;
  restartTimer = setTimeout(() => {
    runSync('continuous-restart', { force: true });
  }, delay);
}

function runSync(trigger, options = {}) {
  const force = options.force === true;
  if (activeSyncChild) {
    if (!force) {
      return {
        started: false,
        reason: 'already_running'
      };
    }
    // Se for forçado, mata o processo atual antes de iniciar um novo
    // eslint-disable-next-line no-console
    console.log(`[sync:${trigger}] interrompendo processo anterior (PID: ${activeSyncChild.pid}) para início forçado.`);
    activeSyncChild.kill('SIGTERM');
    activeSyncChild = null;
  }

  clearRestartTimer();
  const projectRoot = path.join(__dirname, '..');
  const scriptPath = path.join(projectRoot, 'scripts', 'sync-mihon-repos.js');
  const syncScope = process.env.SYNC_SCOPE || 'ongoing';

  // eslint-disable-next-line no-console
  console.log(`[sync:${trigger}] iniciando sincronização de mangás...`);

  const child = spawn(process.execPath, [scriptPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SYNC_SCOPE: syncScope,
      SYNC_CONTINUOUS: continuousModeEnabled ? '1' : '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  activeSyncChild = child;
  lastSyncState = {
    running: true,
    trigger,
    pid: child.pid || null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    error: ''
  };

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[sync:${trigger}] ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[sync:${trigger}] ${chunk}`);
  });

  child.on('close', (code) => {
    const finishedAt = new Date().toISOString();
    const wasActive = activeSyncChild && child.pid === activeSyncChild.pid;
    if (wasActive) {
      activeSyncChild = null;
    }
    lastSyncState = {
      ...lastSyncState,
      running: false,
      pid: null,
      endedAt: finishedAt,
      exitCode: Number.isInteger(code) ? code : null
    };
// eslint-disable-next-line no-console
    console.log(`[sync:${trigger}] finalizado com código ${code}`);

    if (code !== 0 && code !== null) {
      consecutiveFailures++;
    } else {
      consecutiveFailures = 0;
      maxRestartDelay = INITIAL_RESTART_DELAY;
    }

    if (continuousModeEnabled) {
      scheduleContinuousRestart();
    }
  });

  child.on('error', (error) => {
    const finishedAt = new Date().toISOString();
    if (activeSyncChild && child.pid === activeSyncChild.pid) {
      activeSyncChild = null;
    }
    lastSyncState = {
      ...lastSyncState,
      running: false,
      pid: null,
      endedAt: finishedAt,
      exitCode: null,
      error: String(error?.message || error)
    };
    consecutiveFailures++;
    if (continuousModeEnabled) {
      scheduleContinuousRestart();
    }
  });

  return {
    started: true,
    pid: child.pid || null,
    trigger
  };
}

function getSyncStatus() {
  return {
    ...lastSyncState,
    continuousMode: continuousModeEnabled
  };
}

function startDailySyncScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  continuousModeEnabled = readContinuousFlag();
  const timezone = process.env.SYNC_TIMEZONE || 'America/Sao_Paulo';
  if (continuousModeEnabled) {
    // eslint-disable-next-line no-console
    console.log('[sync] modo contínuo habilitado; sincronização executará em loop.');
    runSync('startup');
    return;
  }

  cron.schedule(
    '0 0 * * *',
    () => {
      runSync('cron');
    },
    {
      timezone
    }
  );

  // eslint-disable-next-line no-console
  console.log(`[sync] agendado para rodar diariamente às 00:00 (${timezone}).`);

  if (process.env.RUN_SYNC_ON_START !== '0') {
    runSync('startup');
  }
}

function stopSync() {
  if (activeSyncChild) {
    // eslint-disable-next-line no-console
    console.log(`[sync] abortando processo atual (PID: ${activeSyncChild.pid})...`);
    activeSyncChild.kill('SIGTERM');
    // activeSyncChild será limpo no callback do evento 'close'
    return true;
  }
  return false;
}

module.exports = {
  startDailySyncScheduler,
  runSync,
  getSyncStatus,
  stopSync
};
