#!/usr/bin/env bash
# Разворачивает b24-kit-queue на чистой Ubuntu 22.04/24.04 одной командой.
#
#   git clone https://github.com/Umkladet/bitrix24-kit-pds2connector.git /opt/b24-kit-queue && sudo bash /opt/b24-kit-queue/deploy/install.sh
#
# Повторный запуск безопасен: подтягивает код, пересобирает и перезапускает контейнеры,
# .env не трогает. Обновление после git pull: sudo bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/b24-kit-queue
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ $EUID -eq 0 ]] || { echo "Нужен root: sudo bash $0"; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ask() { # ask VAR "подсказка" "значение по умолчанию"
  local var=$1 prompt=$2 def=${3:-} val
  if [[ -n $def ]]; then read -rp "$prompt [$def]: " val; val=${val:-$def}
  else while :; do read -rp "$prompt: " val; [[ -n $val ]] && break; echo "  поле обязательное"; done; fi
  printf -v "$var" '%s' "$val"
}

step "Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null
docker compose version >/dev/null || { echo "Нет docker compose plugin"; exit 1; }

step "Файрвол, автообновления безопасности, swap"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq ufw unattended-upgrades >/dev/null
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Код → $APP_DIR"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  mkdir -p "$APP_DIR"
  tar -C "$SRC_DIR" --exclude=.env --exclude=node_modules -cf - . | tar -C "$APP_DIR" -xf -
fi
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  step "Конфигурация (.env ещё нет)"
  [[ -t 0 ]] || { echo "Нет терминала для вопросов. Создайте $APP_DIR/.env по образцу .env.example и запустите снова."; exit 1; }
  echo "Токены можно оставить пустыми и вписать в .env позже — сервис поднимется, но будет отклонять вебхуки / не отправлять в Kit."
  ask APP_DOMAIN     "Домен сервиса (A-запись уже указывает на этот сервер)" "kit.umklaidet.ru"
  ask ACME_EMAIL     "E-mail для Let's Encrypt"
  ask B24_PORTAL     "Портал Битрикс24" "ukids-academy.bitrix24.ru"
  ask B24_REST_URL   "Входящий вебхук Б24 (https://…/rest/ID/CODE/)"
  ask B24_APP_TOKEN  "application_token исходящего вебхука Б24" "CHANGE_ME"
  ask B24_STAGE      "Целевая стадия сделки (STAGE_ID, напр. C0:NEW)"
  ask KIT_DOMAIN     "Домен Kit" "ukids"
  ask KIT_TOKEN      "access_token Kit" "CHANGE_ME"
  ask KIT_CAMPAIGN   "ID кампании Kit" "1576"
  cat > .env <<ENV
APP_DOMAIN=$APP_DOMAIN
ACME_EMAIL=$ACME_EMAIL
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)

B24_REST_URL=$B24_REST_URL
B24_PORTAL=$B24_PORTAL
B24_APP_TOKEN=$B24_APP_TOKEN
B24_TRIGGER_STAGE_ID=$B24_STAGE

KIT_DOMAIN=$KIT_DOMAIN
KIT_ACCESS_TOKEN=$KIT_TOKEN
KIT_CAMPAIGN_ID=$KIT_CAMPAIGN

# Прерываемая ВМ: сверять чаще, чтобы быстрее подбирать сделки после простоя
RECONCILE_POLL_MS=300000
ENV
  chmod 600 .env
  echo ".env записан. Остальные параметры и их дефолты — в .env.example"
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a
: "${APP_DOMAIN:?в .env нет APP_DOMAIN}"

step "DNS: $APP_DOMAIN"
MY_IP=$(curl -4 -fsS --max-time 5 https://api.ipify.org || true)
DNS_IP=$(getent ahostsv4 "$APP_DOMAIN" | awk 'NR==1{print $1}' || true)
if [[ -z $DNS_IP ]]; then
  echo "  ВНИМАНИЕ: $APP_DOMAIN не резолвится. Caddy не сможет получить сертификат, пока A-запись не разойдётся."
elif [[ -n $MY_IP && $DNS_IP != "$MY_IP" ]]; then
  echo "  ВНИМАНИЕ: $APP_DOMAIN → $DNS_IP, а публичный IP этой машины $MY_IP. Проверьте A-запись."
else
  echo "  ok: $APP_DOMAIN → $DNS_IP"
fi

step "Запуск контейнеров"
docker compose up -d --build --remove-orphans

step "Ежедневный бэкап БД (03:00, /var/backups/b24-kit-queue)"
chmod +x deploy/backup.sh
echo "0 3 * * * root $APP_DIR/deploy/backup.sh >> /var/log/b24kit-backup.log 2>&1" > /etc/cron.d/b24-kit-queue

step "Проверка"
for _ in $(seq 1 24); do
  if curl -fsS --max-time 5 "https://$APP_DOMAIN/health" 2>/dev/null | grep -q ok; then
    echo "  https://$APP_DOMAIN/health → ok"; HEALTHY=1; break
  fi
  sleep 5
done
if [[ -z ${HEALTHY:-} ]]; then
  echo "  За 2 минуты сервис не ответил по HTTPS. Смотрите: docker compose -f $APP_DIR/docker-compose.yml logs caddy app"
fi

step "Готово"
cat <<TXT
  URL для исходящего вебхука Битрикс24:  https://$APP_DOMAIN${WEBHOOK_PATH:-/b24/webhook}
  Конфиг:                                $APP_DIR/.env  (после правки: cd $APP_DIR && docker compose up -d)
  Логи:                                  cd $APP_DIR && docker compose logs -f app
  Очередь:                               cd $APP_DIR && docker compose exec db psql -U b24kit b24kit -c "SELECT status,count(*) FROM b24_kit_queue GROUP BY 1"
TXT
[[ ${B24_APP_TOKEN:-} == CHANGE_ME || ${KIT_ACCESS_TOKEN:-} == CHANGE_ME ]] && \
  echo "  ! В .env остались значения CHANGE_ME — впишите токены и выполните: cd $APP_DIR && docker compose up -d"
exit 0
