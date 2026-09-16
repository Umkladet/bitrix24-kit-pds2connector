'use strict';

function env(name, def) {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    if (def === undefined) throw new Error(`Не задана переменная окружения ${name}`);
    return def;
  }
  return v.trim();
}

function num(name, def) {
  const v = Number(env(name, String(def)));
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} должно быть положительным числом`);
  return v;
}

/** Секрет: пусто или заглушка CHANGE_ME считаются «не задан» */
function secret(name) {
  const v = env(name, '');
  return v === 'CHANGE_ME' ? '' : v;
}

module.exports = {
  port: num('PORT', 3000),
  webhookPath: env('WEBHOOK_PATH', '/b24/webhook'),
  webhookSecret: secret('WEBHOOK_SECRET'),
  databaseUrl: env('DATABASE_URL'),
  httpTimeoutMs: num('HTTP_TIMEOUT_MS', 15000),

  b24: {
    restUrl: env('B24_REST_URL').replace(/\/?$/, '/'),
    portal: env('B24_PORTAL'),
    appToken: secret('B24_APP_TOKEN'),
    memberId: env('B24_MEMBER_ID', ''),
    events: env('B24_EVENTS', 'ONCRMDEALADD,ONCRMDEALUPDATE')
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    triggerStageId: env('B24_TRIGGER_STAGE_ID', ''),
    categoryId: env('B24_CATEGORY_ID', ''),
    rps: num('B24_RPS', 2),
    pollMs: num('B24_POLL_MS', 5000),
    batchSize: num('B24_BATCH_SIZE', 4),
  },

  kit: {
    baseUrl: env('KIT_BASE_URL', 'https://kitapi-ru.voximplant.com').replace(/\/$/, ''),
    domain: env('KIT_DOMAIN'),
    accessToken: env('KIT_ACCESS_TOKEN'),
    campaignId: env('KIT_CAMPAIGN_ID'),
    taskPriority: env('KIT_TASK_PRIORITY', '1'),
    timezone: env('KIT_TIMEZONE', ''),
    tzAutodetect: env('KIT_TZ_AUTODETECT', 'true') !== 'false',
    rps: num('KIT_RPS', 2),
    pollMs: num('KIT_POLL_MS', 60000),
    chunkSize: num('KIT_CHUNK_SIZE', 100),
    maxPerTick: num('KIT_MAX_PER_TICK', 1000),
  },

  reconcile: {
    enabled: env('RECONCILE_ENABLED', 'true') !== 'false',
    pollMs: num('RECONCILE_POLL_MS', 900000),
    lookbackMin: num('RECONCILE_LOOKBACK_MIN', 120),
    maxPages: num('RECONCILE_MAX_PAGES', 20),
    recheckMin: num('RECONCILE_RECHECK_MIN', 60),
  },

  retry: {
    maxAttempts: num('MAX_ATTEMPTS', 8),
    baseSec: num('RETRY_BASE_SEC', 30),
    maxSec: num('RETRY_MAX_SEC', 1800),
  },

  retentionDays: num('RETENTION_DAYS', 30),
};

if (!module.exports.b24.appToken && !module.exports.webhookSecret) {
  throw new Error('Нужен хотя бы один из B24_APP_TOKEN (исходящий вебхук) или WEBHOOK_SECRET (?key= в URL робота)');
}
