'use strict';
const { setTimeout: delay } = require('node:timers/promises');

const ts = () => new Date().toISOString();
const log = {
  info: (...a) => console.log(ts(), 'INFO ', ...a),
  warn: (...a) => console.warn(ts(), 'WARN ', ...a),
  error: (...a) => console.error(ts(), 'ERROR', ...a),
};

/**
 * Ограничитель частоты: вызовы выполняются строго последовательно,
 * между началами запросов не меньше 1000/rps мс + 15% запаса на сетевой джиттер
 * (без запаса на стороне получателя изредка видно 3 запроса в секундном окне).
 */
function createLimiter(rps) {
  const interval = Math.ceil((1000 / rps) * 1.15);
  let last = 0;
  let chain = Promise.resolve();
  const run = (fn) => {
    const p = chain.then(async () => {
      const wait = last + interval - Date.now();
      if (wait > 0) await delay(wait);
      last = Date.now();
      return fn();
    });
    chain = p.catch(() => {});
    return p;
  };
  run.interval = interval;
  return run;
}

/** POST без исключений: всегда возвращает { status, json, text }. status 0 = сеть/таймаут. */
async function httpPost(url, { headers, body }, timeoutMs) {
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: `${e.name}: ${e.message}` };
  }
}

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return /^7\d{10}$/.test(d) ? d : null;
}

const maskPhone = (p) => (p ? p.slice(0, 4) + '***' + p.slice(-4) : p);

module.exports = { log, delay, createLimiter, httpPost, normalizePhone, maskPhone };
