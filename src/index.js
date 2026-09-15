'use strict';
const cfg = require('./config');
const { pool, migrate } = require('./db');
const { log, delay } = require('./lib');
const { startWebhookServer } = require('./webhook');
const { b24Tick } = require('./b24-worker');
const { kitTick } = require('./kit-worker');
const { reconcileTick } = require('./reconcile-worker');

/** Цикл без наложений: следующий тик стартует не раньше, чем закончится предыдущий. */
async function runLoop(name, tick, intervalMs, signal) {
  while (!signal.aborted) {
    const started = Date.now();
    try { await tick(); } catch (e) { log.error(`${name}: тик упал — ${e.message}`); }
    const wait = intervalMs - (Date.now() - started);
    if (wait > 0) {
      try { await delay(wait, undefined, { signal }); } catch { break; }
    }
  }
}

async function main() {
  await migrate();
  log.info(`старт: кампания ${cfg.kit.campaignId}, стадия-триггер: ${cfg.b24.triggerStageId || 'любая'}, ` +
    `лимит Б24 ${cfg.b24.rps} rps, Kit ${cfg.kit.rps} rps, ` +
    `сверка: ${cfg.reconcile.enabled && cfg.b24.triggerStageId ? 'раз в ' + (cfg.reconcile.pollMs >= 60000 ? Math.round(cfg.reconcile.pollMs / 60000) + ' мин' : Math.round(cfg.reconcile.pollMs / 1000) + ' с') : 'выключена'}`);

  const server = startWebhookServer();
  const ac = new AbortController();
  const loops = [
    runLoop('b24', b24Tick, cfg.b24.pollMs, ac.signal),
    runLoop('kit', kitTick, cfg.kit.pollMs, ac.signal),
  ];

  if (cfg.reconcile.enabled && cfg.b24.triggerStageId) {
    loops.push(runLoop('reconcile', reconcileTick, cfg.reconcile.pollMs, ac.signal));
  } else if (cfg.reconcile.enabled) {
    log.warn('сверка выключена: не задан B24_TRIGGER_STAGE_ID. ' +
      'Вебхуки, пришедшие во время простоя сервера, будут потеряны');
  }

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: останавливаюсь, дожидаюсь текущих тиков`);
    ac.abort();
    server.close();
    await Promise.allSettled(loops);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('старт не удался:', e.message);
  process.exit(1);
});
