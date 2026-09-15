'use strict';
// Сверка: страховка на случай, когда сервер был недоступен и вебхуки не дошли.
// Раз в RECONCILE_POLL_MS запрашивает сделки на целевой стадии, изменённые за
// последние RECONCILE_LOOKBACK_MIN минут, и добавляет в очередь пропущенные.
//
// Требует B24_TRIGGER_STAGE_ID: без целевой стадии выборка «все сделки подряд»
// не имеет смысла, поэтому сверка просто не запускается.
const cfg = require('./config');
const { pool, withAdvisoryLock } = require('./db');
const { log } = require('./lib');
const { b24, b24Interval } = require('./b24');

const LOCK_KEY = 724103;
const sentKey = cfg.b24.triggerStageId || '';
const PAGE = 50; // размер страницы crm.deal.list в Битриксе

// Добавляем сделки, которых нет в журнале отправленных и нет в очереди — активных
// (new/ready) или финальных (skipped/ошибка), обновлённых за последние $3 минут.
// Финальные перепроверяются не чаще раза в $3 минут: так сделка без телефона не
// добавляется на каждой сверке, но подхватится, если телефон контакту дописали позже.
const INSERT_SQL = `
  INSERT INTO b24_kit_queue (deal_id, event)
  SELECT d, 'RECONCILE' FROM unnest($1::bigint[]) AS d
  WHERE NOT EXISTS (
        SELECT 1 FROM b24_kit_queue q WHERE q.deal_id = d
          AND (q.status IN ('new', 'ready') OR q.updated_at > now() - make_interval(mins => $3)))
    AND NOT EXISTS (SELECT 1 FROM b24_kit_sent s WHERE s.deal_id = d AND s.stage_id = $2)
  ON CONFLICT (deal_id) WHERE status IN ('new', 'ready') DO NOTHING
  RETURNING deal_id`;

/** Формат даты для фильтра Битрикса: 2026-09-15T08:30:00+03:00 */
function b24Date(d) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

async function fetchDealIds() {
  const since = new Date(Date.now() - cfg.reconcile.lookbackMin * 60_000);
  const filter = { STAGE_ID: cfg.b24.triggerStageId, '>DATE_MODIFY': b24Date(since) };
  if (cfg.b24.categoryId) filter.CATEGORY_ID = cfg.b24.categoryId;

  const ids = [];
  let start = 0;
  for (let page = 0; page < cfg.reconcile.maxPages; page++) {
    const r = await b24('crm.deal.list', {
      filter,
      select: ['ID'],
      order: { ID: 'ASC' },
      start,
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) log.error(`ALERT reconcile: ошибка авторизации — ${r.error}`);
      log.warn(`reconcile: ${r.error} — пропуск цикла`);
      return null;
    }
    for (const d of r.result || []) ids.push(Number(d.ID));
    if (typeof r.next !== 'number' || (r.result || []).length < PAGE) break;
    start = r.next;
    if (page === cfg.reconcile.maxPages - 1) {
      log.warn(`reconcile: достигнут предел в ${cfg.reconcile.maxPages} страниц, часть сделок не проверена`);
    }
  }
  return ids;
}

async function reconcileTick() {
  if (!cfg.b24.triggerStageId) return;

  await withAdvisoryLock(LOCK_KEY, b24Interval, async () => {
    const ids = await fetchDealIds();
    if (ids === null) return;
    if (!ids.length) { log.info('reconcile: сделок на целевой стадии за период нет'); return; }

    const { rows } = await pool.query(INSERT_SQL, [ids, sentKey, cfg.reconcile.recheckMin]);
    if (rows.length) {
      log.warn(`reconcile: добавлено пропущенных вебхуками сделок: ${rows.length} ` +
        `(${rows.slice(0, 20).map((r) => r.deal_id).join(',')}${rows.length > 20 ? ', …' : ''})`);
    } else {
      log.info(`reconcile: проверено ${ids.length}, пропущенных нет`);
    }
  });
}

module.exports = { reconcileTick };
