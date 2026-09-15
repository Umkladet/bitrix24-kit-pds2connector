'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const cfg = require('./config');
const { log, delay } = require('./lib');

const pool = new Pool({ connectionString: cfg.databaseUrl, max: 5 });
pool.on('error', (e) => log.error('pg pool:', e.message));

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
}

/**
 * Страховка от запуска нескольких экземпляров воркера: тик выполняется только под
 * advisory-lock. Перед снятием лока выдерживаем holdMs, чтобы следующий владелец лока
 * (другой экземпляр) не нарушил лимит RPS на стыке тиков.
 */
async function withAdvisoryLock(key, holdMs, fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!rows[0].ok) {
      log.warn(`lock ${key} занят — запущен второй экземпляр воркера? Тик пропущен`);
      return;
    }
    try {
      await fn();
      await delay(holdMs);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}

// Общий SQL для неуспешной попытки: backoff = min(base * 2^attempts, max),
// после maxAttempts — финальный статус ошибки.
const FAIL_SQL = (statusCol, finalStatus) => `
  UPDATE b24_kit_queue SET
    attempts        = attempts + 1,
    ${statusCol}    = $2,
    reason          = $3,
    status          = CASE WHEN attempts + 1 >= $4 THEN '${finalStatus}' ELSE status END,
    next_attempt_at = now() + make_interval(secs => LEAST($5 * power(2, attempts), $6)),
    updated_at      = now()
  WHERE id = ANY($1::bigint[])
  RETURNING id, deal_id, status, attempts`;

module.exports = { pool, migrate, withAdvisoryLock, FAIL_SQL };
