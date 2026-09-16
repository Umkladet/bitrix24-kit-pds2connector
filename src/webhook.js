'use strict';
// Приём вебхука Б24: только проверка и запись в очередь.
//
// Поддерживаются два формата, которые шлёт Битрикс:
//   1. Исходящий вебхук по событию (Разработчикам → Исходящий вебхук):
//      event=ONCRMDEALUPDATE, data[FIELDS][ID]=<deal>, auth[application_token]=<token>
//   2. Робот «Вебхук» из автоматизации CRM (срабатывает при входе сделки на стадию):
//      document_id[1]=CCrmDocumentDeal, document_id[2]=DEAL_<deal>, без event и без токена
//
// Авторизация: auth[domain] должен совпасть с B24_PORTAL, и хотя бы одно из:
//   - auth[application_token] == B24_APP_TOKEN            (формат 1)
//   - ?key=<WEBHOOK_SECRET> в URL обработчика              (формат 2, подходит и для 1)
// Опционально auth[member_id] == B24_MEMBER_ID.
const http = require('node:http');
const crypto = require('node:crypto');
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

/** Сравнение секретов без утечки по времени; пустой эталон никогда не совпадает */
function safeEq(actual, expected) {
  if (!expected || typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

/** @returns {{event: string, dealId: number}|null} */
function parseDeal(p) {
  const event = (p.get('event') || '').toUpperCase();
  const fromEvent = Number(p.get('data[FIELDS][ID]'));
  if (event && Number.isInteger(fromEvent) && fromEvent > 0) return { event, dealId: fromEvent };

  const m = /^DEAL_(\d+)$/.exec(p.get('document_id[2]') || '');
  if (m && p.get('document_id[1]') === 'CCrmDocumentDeal') return { event: 'ROBOT', dealId: Number(m[1]) };
  return null;
}

async function handle(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/health') {
    try { await pool.query('SELECT 1'); return send(res, 200, 'ok'); }
    catch { return send(res, 503, 'db unavailable'); }
  }
  if (req.method !== 'POST' || pathname !== cfg.webhookPath) return send(res, 404, 'not found');

  let raw;
  try { raw = await readBody(req); } catch { return send(res, 413, 'too large'); }
  const p = new URLSearchParams(raw);

  const domain = p.get('auth[domain]');
  const authOk = domain === cfg.b24.portal
    && (!cfg.b24.memberId || safeEq(p.get('auth[member_id]'), cfg.b24.memberId))
    && (safeEq(p.get('auth[application_token]'), cfg.b24.appToken)
        || safeEq(searchParams.get('key'), cfg.webhookSecret));
  if (!authOk) {
    log.warn(`webhook: не прошёл проверку (domain=${domain}, ` +
      `application_token=${p.has('auth[application_token]') ? 'есть' : 'нет'}, key=${searchParams.has('key') ? 'есть' : 'нет'}) — отклонено`);
    return send(res, 403, 'forbidden');
  }

  const deal = parseDeal(p);
  if (!deal) {
    log.warn(`webhook: не удалось определить сделку (event=${p.get('event')}, document_id=${p.get('document_id[1]')}/${p.get('document_id[2]')})`);
    return send(res, 400, 'bad deal id');
  }
  if (deal.event !== 'ROBOT' && !cfg.b24.events.includes(deal.event)) return send(res, 200, 'ignored');

  try {
    const r = await pool.query(INSERT_SQL, [deal.dealId, deal.event]);
    log.info(r.rowCount ? `webhook: deal ${deal.dealId} в очереди (${deal.event})` : `webhook: deal ${deal.dealId} уже в очереди — дубль`);
    return send(res, 200, 'ok');
  } catch (e) {
    log.error(`webhook: deal ${deal.dealId} не записан в БД — ${e.message}`);
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
