'use strict';
// Клиент REST Битрикс24. Ограничитель частоты один на весь процесс: его используют
// и воркер обогащения, и сверка, поэтому суммарно к порталу уходит не больше B24_RPS в секунду.
const cfg = require('./config');
const { createLimiter, httpPost } = require('./lib');

const limit = createLimiter(cfg.b24.rps);

/**
 * Ответы REST Б24:
 *   200 { result }                                   — успех
 *   400 { error: '', error_description: 'Not found' } — сущность не найдена (удалена)
 *   401 INVALID_CREDENTIALS / NO_AUTH_FOUND          — битый входящий вебхук
 *   403 ACCESS_DENIED / insufficient_scope           — нет прав у вебхука
 *   503 QUERY_LIMIT_EXCEEDED / OVERLOAD_LIMIT        — превышен лимит запросов
 *   5xx                                              — ошибка портала
 *
 * @returns {{ok: true, status: 200, result: *, next: number|undefined}
 *          |{ok: false, status: number, error: string}}
 */
async function b24(method, params) {
  const r = await limit(() => httpPost(
    `${cfg.b24.restUrl}${method}.json`,
    { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) },
    cfg.httpTimeoutMs,
  ));
  if (r.status === 200 && r.json && 'result' in r.json) {
    return { ok: true, status: 200, result: r.json.result, next: r.json.next };
  }
  const error = r.json
    ? [r.json.error, r.json.error_description].filter(Boolean).join(': ')
    : r.text.slice(0, 300);
  return { ok: false, status: r.status, error: `${method}: ${error || 'HTTP ' + r.status}` };
}

const isNotFound = (r) => r.status === 400 && /not found/i.test(r.error);

module.exports = { b24, isNotFound, b24Interval: limit.interval };
