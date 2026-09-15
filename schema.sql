-- Очередь заявок Б24 → Kit. Применяется автоматически при старте сервиса (идемпотентно).

CREATE TABLE IF NOT EXISTS b24_kit_queue (
  id              BIGSERIAL   PRIMARY KEY,
  deal_id         BIGINT      NOT NULL,
  event           TEXT        NOT NULL,
  -- new       — пришёл вебхук, ждёт обогащения из Б24
  -- ready     — данные из Б24 получены, ждёт отправки в Kit
  -- skipped   — финально пропущена (нет контакта/телефона, сделка удалена), см. reason
  -- b24_error — Б24 не ответил успешно за MAX_ATTEMPTS попыток
  -- kit_error — Kit не принял за MAX_ATTEMPTS попыток
  -- Успешно отправленные в Kit строки удаляются.
  status          TEXT        NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'ready', 'skipped', 'b24_error', 'kit_error')),
  stage_id        TEXT,
  contact_id      BIGINT,
  phone           TEXT,
  b24_status      INT,        -- HTTP-код последнего ответа Б24 (0 = сеть/таймаут)
  kit_status      INT,        -- HTTP-код последнего ответа Kit (0 = сеть/таймаут)
  reason          TEXT,       -- причина пропуска или текст последней ошибки
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Одна активная заявка на сделку: повторные вебхуки по той же сделке отбрасываются на входе
CREATE UNIQUE INDEX IF NOT EXISTS b24_kit_queue_active_deal_uq
  ON b24_kit_queue (deal_id) WHERE status IN ('new', 'ready');

CREATE INDEX IF NOT EXISTS b24_kit_queue_pick_idx
  ON b24_kit_queue (status, next_attempt_at, id);

-- Журнал отправленных сделок: не даёт отправить сделку повторно после удаления из очереди.
-- stage_id = B24_TRIGGER_STAGE_ID (или '' если фильтр по стадии не задан)
CREATE TABLE IF NOT EXISTS b24_kit_sent (
  deal_id  BIGINT      NOT NULL,
  stage_id TEXT        NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, stage_id)
);
