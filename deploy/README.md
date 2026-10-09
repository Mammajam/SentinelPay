# Deploying SentinelPay to Cloud Run (sandbox stage)

Project `gcp-workshop-501215` · region `us-east5` (Columbus, next to Neon `aws-us-east-2`) · service `sentinelpay`.
**Sandbox only.** `PAYPAL_BASE_URL` points at PayPal's sandbox; live hosts are refused unless `PAYPAL_ALLOW_LIVE=1`.

## Deploy / update
```bash
deploy/cloudrun.sh            # idempotent; PLAN=1 prints actions without changing anything
```
It enables APIs, creates `sentinelpay-run` (service account), five `sentinelpay-*` secrets from `.env.local`, the
anchor bucket, deploys via Cloud Build, and creates an hourly Cloud Scheduler job. It never touches other services in the project.

## Resources it creates (delete these to remove SentinelPay)
| Kind | Name |
|---|---|
| Cloud Run service | `sentinelpay` (public ingress; the app does its own auth) |
| Service account | `sentinelpay-run@gcp-workshop-501215.iam.gserviceaccount.com` (roles: `aiplatform.user`, per-secret `secretAccessor`, bucket `objectCreator`) |
| Secrets | `sentinelpay-database-url`, `-master-key`, `-session-secret`, `-cron-secret`, `-anchor-hmac-key` |
| GCS bucket | `gcp-workshop-501215-sentinelpay-anchors` (30-day retention, **unlocked**) |
| Scheduler job | `sentinelpay-anchor` in `us-east4`, hourly `POST /api/admin/anchor` |

## Verify
```bash
URL=$(gcloud run services describe sentinelpay --region us-east5 --format 'value(status.url)')
curl -s $URL/api/health ; curl -s $URL/api/ready ; curl -s $URL/api/agent/openapi | head -c 200
```
Logs are JSON (`severity`, `event`, …): `gcloud run services logs read sentinelpay --region us-east5 --limit 50`.

## Manual steps that are deliberately NOT automated
1. **Lock the anchor bucket retention** once you are happy: `gcloud storage buckets update gs://gcp-workshop-501215-sentinelpay-anchors --lock-retention-period`. **Irreversible**: objects (and the bucket) cannot be deleted until retention expires. This is what turns anchors into tamper-evident, externally held proof.
2. **Alerts**: create log-based metrics/alerts on `event="webhook.rejected"`, `event="rate_limited"`, `event="admin.login_failed"` (spikes), `event="order.capture_failed"`, and `severity>=ERROR`.
3. **Custom domain / Cloud Armor** if you want WAF/DDoS rules in front of the public service.
4. The scheduler job stores `CRON_SECRET` in its header (visible to project admins). Rotate by changing the secret, re-running the script.

## Rollback
`gcloud run services update-traffic sentinelpay --region us-east5 --to-revisions <previous-revision>=100`

## Notes
- `NODE_ENV=production` in the image disables the PayPal simulator's certificate allowance by design; a hosted copy cannot use the simulator.
- Gemini runs through Vertex AI using the service account (no API key on Cloud Run), billed to the GCP project, not AI Studio credits.
- Operator CLI (`npm run admin -- …`) runs from your laptop against the same Neon database, so keys created there work on Cloud Run.
