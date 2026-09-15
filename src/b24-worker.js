'use strict';
// Воркер обогащения: раз в B24_POLL_MS берёт заявки 'new', читает сделку и контакт из Б24,
// пишет результат обратно в очередь.
const cfg = require('./config');
const { pool, withAdvisoryLock, FAIL_SQL } = require('./db');
const { log, maskPhone, normalizePhone } = require('./lib');
const { b24, isNotFound, b24Interval } = require('./b24');

const LOCK_KEY = 724101;
const sentKey = cfg.b24.triggerStageId || '';

function pickPhone(phones) {
  for (const p of Array.isArray(phones) ? phones : []) {
    const n = normalizePhone(p && p.VALUE);
    if (n) return n;
  }
  return null;
}

async function markReady(row, stageId, contactId, phone) {
  await pool.query(`
    UPDATE b24_kit_queue SET status = 'ready', stage_id = $2, contact_id = $3, phone = $4,
      b24_status = 200, reason = NULL, attempts = 0, next_attempt_at = now(), updated_at = now()
    WHERE id = $1`, [row.id, stageId, contactId, phone]);
  log.info(`b24: deal ${row.deal_id} → ready (contact ${contactId}, ${maskPhone(phone)})`);
}

async function markSkipped(row, b24Status, reason, stageId = null, contactId = null) {
  await pool.query(`
    UPDATE b24_kit_queue SET status = 'skipped', b24_status = $2, reason = $3,
      stage_id = $4, contact_id = $5, updated_at = now()
    WHERE id = $1`, [row.id, b24Status, reason, stageId, contactId]);
  log.info(`b24: deal ${row.deal_id} → skipped (${reason})`);
}

// Заявки, которые не нужно хранить (не та стадия, уже отправлена), удаляем сразу —
// иначе ONCRMDEALUPDATE на каждое изменение сделки забьёт таблицу.
async function drop(row, why) {
  await pool.query('DELETE FROM b24_kit_queue WHERE id = $1', [row.id]);
  log.info(`b24: deal ${row.deal_id} удалена из очереди (${why})`);
}

async function markFailed(row, r) {
  if (r.status === 401 || r.status === 403) log.error(`ALERT b24: ошибка авторизации входящего вебхука — ${r.error}`);
  const { rows } = await pool.query(FAIL_SQL('b24_status', 'b24_error'),
    [[row.id], r.status, r.error, cfg.retry.maxAttempts, cfg.retry.baseSec, cfg.retry.maxSec]);
  const s = rows[0];
  log.warn(`b24: deal ${row.deal_id} попытка ${s.attempts} неуспешна (${r.status} ${r.error})` +
    (s.status === 'b24_error' ? ' → b24_error' : ' → повтор позже'));
}

async function processRow(row) {
  const deal = await b24('crm.deal.get', { id: row.deal_id });
  if (!deal.ok) return isNotFound(deal) ? markSkipped(row, deal.status, 'deal_not_found') : markFailed(row, deal);

  const stageId = deal.result.STAGE_ID;
  if (cfg.b24.triggerStageId && stageId !== cfg.b24.triggerStageId) return drop(row, `стадия ${stageId} не целевая`);

  const sent = await pool.query('SELECT 1 FROM b24_kit_sent WHERE deal_id = $1 AND stage_id = $2', [row.deal_id, sentKey]);
  if (sent.rowCount) return drop(row, 'уже отправлена в Kit ранее');

  const contactId = Number(deal.result.CONTACT_ID) || 0;
  if (!contactId) return markSkipped(row, 200, 'no_contact', stageId);

  const contact = await b24('crm.contact.get', { id: contactId });
  if (!contact.ok) {
    return isNotFound(contact) ? markSkipped(row, contact.status, 'contact_not_found', stageId, contactId) : markFailed(row, contact);
  }

  const phone = pickPhone(contact.result.PHONE);
  if (!phone) return markSkipped(row, 200, contact.result.PHONE ? 'invalid_phone' : 'no_phone', stageId, contactId);

  return markReady(row, stageId, contactId, phone);
}

async function b24Tick() {
  await withAdvisoryLock(LOCK_KEY, b24Interval, async () => {
    const { rows } = await pool.query(`
      SELECT id, deal_id FROM b24_kit_queue
      WHERE status = 'new' AND next_attempt_at <= now()
      ORDER BY id LIMIT $1`, [cfg.b24.batchSize]);
    for (const row of rows) {
      try { await processRow(row); }
      catch (e) { log.error(`b24: deal ${row.deal_id} — ${e.message}`); } // ошибка БД: заявка останется 'new'
    }
  });
}

module.exports = { b24Tick };
