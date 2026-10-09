#!/usr/bin/env bash
# Deploy SentinelPay (sandbox-stage) to Google Cloud Run. Idempotent: safe to re-run.
#
#   deploy/cloudrun.sh            # deploy / update
#   PLAN=1 deploy/cloudrun.sh     # print what would be created, change nothing
#
# Touches ONLY resources named sentinelpay-* (the project hosts other services; they are left alone).
# Secrets are read from .env.local and sent to Secret Manager over stdin; values are never printed.
# The bucket retention policy is set but deliberately NOT locked (locking is irreversible): see deploy/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-gcp-workshop-501215}"
REGION="${REGION:-us-east5}"                 # next to Neon (aws us-east-2, Ohio) to keep DB round trips short
SCHED_REGION="${SCHED_REGION:-us-east4}"     # Cloud Scheduler is not offered in every Cloud Run region
SERVICE="${SERVICE:-sentinelpay}"
SA_NAME="sentinelpay-run"
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
BUCKET="${PROJECT}-sentinelpay-anchors"
ENV_FILE="${ENV_FILE:-.env.local}"
RETENTION="${RETENTION:-30d}"

run() { if [ "${PLAN:-0}" = "1" ]; then echo "[plan] $*"; else "$@"; fi; }
say() { printf '\n==> %s\n' "$*"; }
val() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }   # raw value of KEY from the env file

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
for k in DATABASE_URL SENTINEL_MASTER_KEY SESSION_SECRET CRON_SECRET ANCHOR_HMAC_KEY; do
  [ -n "$(val $k)" ] || { echo "$k is empty in $ENV_FILE" >&2; exit 1; }
done
case "$(val DATABASE_URL)" in postgresql://*) ;; *) echo "DATABASE_URL must start with exactly one postgresql://" >&2; exit 1;; esac

say "Project $PROJECT, region $REGION, service $SERVICE"
gcloud config set project "$PROJECT" >/dev/null

say "Enabling APIs (idempotent)"
run gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com aiplatform.googleapis.com storage.googleapis.com cloudscheduler.googleapis.com \
  logging.googleapis.com monitoring.googleapis.com

say "Service account $SA"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  run gcloud iam service-accounts create "$SA_NAME" --display-name "SentinelPay Cloud Run runtime"
fi
# Vertex AI (Gemini via the platform; no API key needed on Cloud Run).
run gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role roles/aiplatform.user --condition=None >/dev/null

say "Secrets (values never printed)"
declare -a SECRET_MAP=(
  "DATABASE_URL:sentinelpay-database-url"
  "SENTINEL_MASTER_KEY:sentinelpay-master-key"
  "SESSION_SECRET:sentinelpay-session-secret"
  "CRON_SECRET:sentinelpay-cron-secret"
  "ANCHOR_HMAC_KEY:sentinelpay-anchor-hmac-key"
)
SET_SECRETS=""
for pair in "${SECRET_MAP[@]}"; do
  env_name="${pair%%:*}"; secret="${pair##*:}"
  if ! gcloud secrets describe "$secret" >/dev/null 2>&1; then
    run gcloud secrets create "$secret" --replication-policy=automatic >/dev/null
    [ "${PLAN:-0}" = "1" ] || printf %s "$(val "$env_name")" | gcloud secrets versions add "$secret" --data-file=- >/dev/null
    echo "created $secret"
  else
    # add a new version only if the value changed (compare by hash, never print)
    cur="$(gcloud secrets versions access latest --secret "$secret" 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"
    new="$(printf %s "$(val "$env_name")" | shasum -a 256 | cut -d' ' -f1)"
    if [ "$cur" != "$new" ]; then
      [ "${PLAN:-0}" = "1" ] || printf %s "$(val "$env_name")" | gcloud secrets versions add "$secret" --data-file=- >/dev/null
      echo "updated $secret (new version)"
    else
      echo "unchanged $secret"
    fi
  fi
  run gcloud secrets add-iam-policy-binding "$secret" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor --condition=None >/dev/null
  SET_SECRETS="${SET_SECRETS:+$SET_SECRETS,}$env_name=$secret:latest"
done

say "Anchor bucket gs://$BUCKET (retention $RETENTION, NOT locked)"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  run gcloud storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
fi
run gcloud storage buckets update "gs://$BUCKET" --retention-period "$RETENTION"
# objectCreator = create-only: the service can write anchors but can never overwrite or delete one.
run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA" --role roles/storage.objectCreator >/dev/null

say "Building and deploying (Cloud Build -> Cloud Run)"
run gcloud run deploy "$SERVICE" --source . --region "$REGION" \
  --allow-unauthenticated \
  --service-account "$SA" \
  --min-instances "${MIN_INSTANCES:-0}" --max-instances 5 --memory 512Mi --cpu 1 --concurrency 40 --timeout 30 \
  --set-env-vars "PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com,GEAP_PROJECT=$PROJECT,GEAP_LOCATION=us-central1,GEAP_MODEL=gemini-2.5-flash,ANCHOR_GCS_BUCKET=$BUCKET" \
  --set-secrets "$SET_SECRETS"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)' 2>/dev/null || echo "https://<service-url>")"
say "Service URL: $URL"
run gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "PUBLIC_BASE_URL=$URL" >/dev/null

say "Hourly audit-anchor job (Cloud Scheduler, $SCHED_REGION)"
HDR="Authorization=Bearer $(val CRON_SECRET)"
if gcloud scheduler jobs describe sentinelpay-anchor --location "$SCHED_REGION" >/dev/null 2>&1; then
  run gcloud scheduler jobs update http sentinelpay-anchor --location "$SCHED_REGION" --schedule "0 * * * *" --uri "$URL/api/admin/anchor" --http-method POST --update-headers "$HDR" >/dev/null
else
  run gcloud scheduler jobs create http sentinelpay-anchor --location "$SCHED_REGION" --schedule "0 * * * *" --uri "$URL/api/admin/anchor" --http-method POST --headers "$HDR" >/dev/null
fi

say "Done. Next: curl $URL/api/health ; see deploy/README.md for verification and the manual steps (retention lock, alerts)."
