'use strict';
// Приём исходящего вебхука Б24: только проверка и запись в очередь.
const http = require('node:http');
const cfg = require('./config');
const { pool } = require('./db');
const { log } = require('./lib');

const MAX_BODY = 64 * 1024;

const INSERT_SQL = `
  INSERT INTO b24_kit_queue (deal_id, event) VALUES ($1, $2)
  ON CONFLICT (deal_id) WHERE status IN ('new', 'ready') DO NOTHING`;

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/health') {
    try { await pool.query('SELECT 1'); return send(res, 200, 'ok'); }
    catch { return send(res, 503, 'db unavailable'); }
  }
  if (req.method !== 'POST' || pathname !== cfg.webhookPath) return send(res, 404, 'not found');

  let raw;
  try { raw = await readBody(req); } catch { return send(res, 413, 'too large'); }
  const p = new URLSearchParams(raw);

  if (p.get('auth[application_token]') !== cfg.b24.appToken || p.get('auth[domain]') !== cfg.b24.portal) {
    log.warn(`webhook: неверный application_token или домен (${p.get('auth[domain]')}) — отклонено`);
    return send(res, 403, 'forbidden');
  }

  const event = (p.get('event') || '').toUpperCase();
  if (!cfg.b24.events.includes(event)) return send(res, 200, 'ignored');

  const dealId = Number(p.get('data[FIELDS][ID]'));
  if (!Number.isInteger(dealId) || dealId <= 0) {
    log.warn(`webhook: ${event} без корректного ID сделки`);
    return send(res, 400, 'bad deal id');
  }

  try {
    const r = await pool.query(INSERT_SQL, [dealId, event]);
    log.info(r.rowCount ? `webhook: deal ${dealId} в очереди (${event})` : `webhook: deal ${dealId} уже в очереди — дубль`);
    return send(res, 200, 'ok');
  } catch (e) {
    log.error(`webhook: deal ${dealId} не записан в БД — ${e.message}`);
    return send(res, 500, 'db error');
  }
}

function startWebhookServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { log.error('webhook:', e.message); send(res, 500, 'error'); });
  });
  server.listen(cfg.port, () => log.info(`webhook: слушаю :${cfg.port}${cfg.webhookPath}`));
  return server;
}

module.exports = { startWebhookServer };
