'use strict';
// Воркер отправки: раз в KIT_POLL_MS берёт заявки 'ready', отправляет пачками в Kit,
// успешные удаляет из очереди и пишет в журнал отправленных.
const cfg = require('./config');
const { pool, withAdvisoryLock, FAIL_SQL } = require('./db');
const { log, createLimiter, httpPost } = require('./lib');

const LOCK_KEY = 724102;
const limit = createLimiter(cfg.kit.rps);
const sentKey = cfg.b24.triggerStageId || '';
const url = `${cfg.kit.baseUrl}/api/v3/campaigns/appendContacts?domain=${encodeURIComponent(cfg.kit.domain)}`;

function toKitRow(r) {
  const row = {
    phone1: r.phone,
    contact_link: `https://${cfg.b24.portal}/crm/contact/details/${r.contact_id}`,
    deal_link: `https://${cfg.b24.portal}/crm/deal/details/${r.deal_id}`,
    task_priority: cfg.kit.taskPriority,
  };
  if (cfg.kit.timezone) row.timezone = cfg.kit.timezone;
  return row;
}

async function postRows(rows) {
  const params = {
    access_token: cfg.kit.accessToken,
    campaign_id: cfg.kit.campaignId,
    rows: JSON.stringify(rows.map(toKitRow)),
  };
  // Kit не обрабатывает контакт без таймзоны. Автоопределение — по коду номера.
  if (cfg.kit.tzAutodetect) params.tz_autodetection_enabled = 'true';
  const r = await limit(() => httpPost(url, { body: new URLSearchParams(params) }, cfg.httpTimeoutMs));
  r.answer = (r.json ? JSON.stringify(r.json) : r.text).slice(0, 500);
  r.accepted = r.status === 200 && r.json && r.json.success !== false;
  return r;
}

// Kit отвечает 200 + success:true даже если ни один контакт не принят. Реальный итог —
// в result: { success_contacts, failed_contacts, invalid_phones: [row], invalid_tz: [row],
// invalid_personal_agent: [row] }. Отклонённые строки сопоставляем с заявками по deal_link.
const REJECT_LISTS = ['invalid_phones', 'invalid_tz', 'invalid_personal_agent'];

/** @returns {Map<string, string>} deal_id → причина */
function rejectedByDeal(result) {
  const map = new Map();
  if (!result || typeof result !== 'object') return map;
  for (const key of REJECT_LISTS) {
    for (const row of Array.isArray(result[key]) ? result[key] : []) {
      const m = /details\/(\d+)/.exec((row && row.deal_link) || '');
      if (m) map.set(m[1], key);
    }
  }
  return map;
}

async function markRejected(rows, reasons) {
  for (const row of rows) {
    const why = `kit rejected: ${reasons.get(String(row.deal_id))}`;
    await pool.query(`
      UPDATE b24_kit_queue SET status = 'kit_error', kit_status = 200, reason = $2,
        attempts = attempts + 1, updated_at = now() WHERE id = $1`, [row.id, why]);
    log.warn(`kit: deal ${row.deal_id} отклонена Kit → kit_error (${why})`);
  }
}

async function markSent(rows, answer) {
  await pool.query(`
    WITH done AS (DELETE FROM b24_kit_queue WHERE id = ANY($1::bigint[]) RETURNING deal_id)
    INSERT INTO b24_kit_sent (deal_id, stage_id) SELECT deal_id, $2 FROM done
    ON CONFLICT DO NOTHING`, [rows.map((x) => x.id), sentKey]);
  log.info(`kit: отправлено ${rows.length} (deals ${rows.map((x) => x.deal_id).join(',')}), ответ: ${answer}`);
}

async function markFailed(rows, r) {
  if (r.status === 401 || r.status === 403) log.error(`ALERT kit: ошибка авторизации — ${r.answer}`);
  const res = await pool.query(FAIL_SQL('kit_status', 'kit_error'),
    [rows.map((x) => x.id), r.status, `kit ${r.status}: ${r.answer}`, cfg.retry.maxAttempts, cfg.retry.baseSec, cfg.retry.maxSec]);
  const final = res.rows.filter((x) => x.status === 'kit_error').length;
  log.warn(`kit: не принято ${rows.length} (deals ${rows.map((x) => x.deal_id).join(',')}) — ${r.status}: ${r.answer}` +
    (final ? `, ${final} → kit_error` : ', повтор позже'));
}

// 4xx, кроме авторизации и лимита: Kit не принял данные. Одна невалидная строка
// (чужой формат телефона, лишняя колонка) не должна блокировать всю пачку.
const isDataError = (r) => r.status >= 400 && r.status < 500 && ![401, 403, 429].includes(r.status);

/** @returns {boolean} успех — чтобы при сбое Kit не долбить его остальными пачками в этом тике */
async function sendChunk(chunk) {
  const r = await postRows(chunk);
  if (r.accepted) {
    const res = r.json.result;
    const rejected = rejectedByDeal(res);
    const ok = chunk.filter((x) => !rejected.has(String(x.deal_id)));
    const bad = chunk.filter((x) => rejected.has(String(x.deal_id)));
    const summary = res && typeof res === 'object' && 'success_contacts' in res
      ? `success=${res.success_contacts} failed=${res.failed_contacts}`
      : r.answer;
    if (res && Number(res.failed_contacts) > bad.length) {
      log.error(`kit: Kit отклонил ${res.failed_contacts} контактов, но сопоставить по deal_link удалось только ${bad.length}. Ответ: ${r.answer}`);
    }
    if (ok.length) await markSent(ok, summary);
    if (bad.length) await markRejected(bad, rejected);
    return true;
  }

  if (!isDataError(r) || chunk.length === 1) { await markFailed(chunk, r); return false; }

  // Пачка отклонена как невалидная — ищем виновную строку, отправляя по одной
  log.warn(`kit: пачка из ${chunk.length} отклонена (${r.status}: ${r.answer}) — отправляю по одной`);
  for (const row of chunk) {
    const one = await postRows([row]);
    if (one.accepted) await markSent([row], one.answer);
    else await markFailed([row], one);
  }
  return true; // сама связь с Kit работает, следующие пачки можно отправлять
}

async function kitTick() {
  await withAdvisoryLock(LOCK_KEY, limit.interval, async () => {
    const cleaned = await pool.query(`
      DELETE FROM b24_kit_queue
      WHERE status IN ('skipped', 'b24_error', 'kit_error')
        AND updated_at < now() - make_interval(days => $1)`, [cfg.retentionDays]);
    if (cleaned.rowCount) log.info(`kit: очищено старых финальных заявок: ${cleaned.rowCount}`);

    const { rows } = await pool.query(`
      SELECT id, deal_id, contact_id, phone FROM b24_kit_queue
      WHERE status = 'ready' AND next_attempt_at <= now()
      ORDER BY id LIMIT $1`, [cfg.kit.maxPerTick]);

    for (let i = 0; i < rows.length; i += cfg.kit.chunkSize) {
      if (!(await sendChunk(rows.slice(i, i + cfg.kit.chunkSize)))) break;
    }
  });
}

module.exports = { kitTick };
