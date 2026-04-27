module.exports = {
  apps: [
    {
      name: 'quadroz',
      script: 'server/index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        STATIC_DIR: 'dist',
        SUWAYOMI_BASE: 'http://127.0.0.1:4567',
        SYNC_TIMEZONE: 'America/Sao_Paulo',
        RUN_SYNC_ON_START: '1',
        SYNC_MODE: 'continuous',
        SYNC_CONTINUOUS: '1',
        SYNC_INTERVAL_MS: '720000',
        SYNC_SOURCE_PAGES: '3',
        SYNC_MANGA_PER_SOURCE_LIMIT: '120'
      }
    }
  ]
};
