# Context & next steps

Working notes for the submission pipeline in PR #2. Covers where things stand,
what has to happen to make it live, and the decisions still outstanding.

## Where things stand

| Piece | State |
| --- | --- |
| Tool hosted on GitHub Pages | **Live** at https://vc.use-case-mapping.cdpi.dev/ (HTTPS enforced) |
| Auto-deploy on merge to `main` | **Working** — `.github/workflows/deploy.yml` |
| Export → S3 → Slack pipeline | **Applied** 2026-11-23 in account `770017829617`, `ap-south-1` |
| `CDPI_SUBMIT_ENDPOINT` | **Set** to `https://70lz6ddo2k.execute-api.ap-south-1.amazonaws.com/submit` |
| Viewer from Slack | **Live** — each message has a signed *View use case* button (`GET /view`) |
| Terraform state | **S3** — `s3://cdpi-terraform-state-770017829617/vc-use-case-mapping-tool/infra.tfstate`, native locking |
| Budget | **$100/month** on `Project=vc-use-case-mapping-tool`, alerts to antony@cdpi.dev — **counts $0 until the tag is activated** (see below) |

Smoke tests passed on apply: a valid submission landed in
`cdpi-usecase-submissions-770017829617` and posted to Slack; a disallowed
content type got 415 and a second attachment got 413.

Steps 1–3 below are done; they stay as the record of how to redo it.

## What it does once live

```
browser export ──POST──► API Gateway ──► ingest Lambda ──► S3
                         (CORS + throttle)                  │ ObjectCreated
                                                            │ (manifest.json)
                                                            ▼
                                                     notifier Lambda ──► Slack
```

Each export writes `case.json`, then `files/<export>`, then `manifest.json`
**last**. The S3 event is filtered to `manifest.json`, so one submission = one
Slack message, fired only after every file is durable.

| Trigger | Fired by | Attachment |
| --- | --- | --- |
| `finish` | Finish & export | none — case JSON only |
| `export_json` | JSON export | `.json` |
| `export_excel` | Excel export | `.xlsx` |
| `export_pdf` | PDF / print | `.html` snapshot of the print report |

## Next steps

### 1. Create the Slack webhook

Create an incoming webhook for the destination channel at
https://api.slack.com/messaging/webhooks. Needs a Slack workspace admin if the
app isn't already installed.

```sh
cp infra/terraform.tfvars.example infra/terraform.tfvars   # gitignored
# set slack_webhook_url
```

### 2. Apply the Terraform

```sh
cd infra
terraform init
terraform plan     # expect 20 to add, 0 to change, 0 to destroy
terraform apply
```

Uses the local `cdpi` AWS profile in `ap-south-1`. Whoever applies needs create
permissions for S3, Lambda, IAM roles, API Gateway and CloudWatch Logs.

**State lives in S3** (`cdpi-terraform-state-770017829617`, versioned,
encrypted, TLS-only, locked with `use_lockfile`), so anyone with access can
`terraform init` from a clean checkout. `terraform.tfvars` is still local and
gitignored: a second applier needs the Slack webhook from the first, or can set
`TF_VAR_slack_webhook_url`.

### 3. Wire the endpoint into the tool

```sh
terraform -chdir=infra output -raw submit_endpoint
```

Paste it into `CDPI_SUBMIT_ENDPOINT` in `index.html` (top of the CDPI
submission block), then open a PR. Merging it deploys to Pages automatically.

### 4. Verify end to end

Endpoint reachable and validating:

```sh
ENDPOINT=$(terraform -chdir=infra output -raw submit_endpoint)

# happy path — expect {"ok":true,...} and one Slack message
curl -sS -X POST "$ENDPOINT" -H 'content-type: application/json' \
  -d '{"caseId":"smoke-test","caseName":"Smoke test","trigger":"export_json","case":{"name":"Smoke test"},"files":[]}'

# rejected content type — expect 415, no Slack message
curl -sS -X POST "$ENDPOINT" -H 'content-type: application/json' \
  -d '{"caseId":"bad","case":{},"files":[{"filename":"x.exe","contentType":"application/x-msdownload","data":"AA=="}]}'
```

Then the real path: open the live tool, complete a case, run each of the four
exports, and confirm for each one that the download still works, an object
appears under `submissions/YYYY/MM/DD/`, and exactly one Slack message arrives.

Watch the logs while testing:

```sh
aws --profile cdpi logs tail /aws/lambda/cdpi-usecase-ingest --follow
aws --profile cdpi logs tail /aws/lambda/cdpi-usecase-notifier --follow
```

Check the browser console too — a CORS failure surfaces there and nowhere else,
and `submitToCDPI` swallows it by design so exports never break.

### 5. Rollback

Set `CDPI_SUBMIT_ENDPOINT` back to `''` and merge — submissions stop
immediately, exports keep working, nothing else changes. `terraform destroy`
removes the infrastructure, but the bucket must be emptied first (versioning is
on) and **that deletes every submission received so far**.

## Decisions

**Retention: forever.** Submissions never expire. Superseded object versions
(only produced by an overwrite or delete, which the pipeline never does) still
expire after 90 days.

**Submitter IP: kept.** `manifest.json` records `sourceIp` and `userAgent`. The
viewer does not return them; they are readable in S3 only.

**Viewing from Slack.** Each Slack message carries a *View use case* button —
a link into the tool with an HMAC signature of that submission's prefix in the
`#fragment`. The tool fetches `GET /view`, renders the case as the same report
the PDF export prints, and offers *Save as PDF* plus a download of the
original export (JSON, Excel, or the HTML snapshot of the PDF). Nothing is
saved to the viewer's browser or resubmitted. Anyone holding a link can open
that one case; nobody can list or guess others. Revoke every link at once with
`terraform apply -replace=random_password.view_signing_key`.

**Budget.** `aws_budgets_budget.monthly` alerts antony@cdpi.dev at 80% and
100% of actual spend and when spend is forecast past 100% of $100. It filters
on the `Project` tag, which this member account cannot activate itself:
**someone with billing access to the management account `730335413791` must
activate it** (Billing → Cost allocation tags → `Project` → Activate). Until
then the budget counts $0 and never alerts.

## Outstanding decisions

**Authentication.** The submit endpoint is unauthenticated. Protection is the
CORS origin allowlist plus API Gateway throttling. CORS stops another site's
page from posting; it does **not** stop a direct scripted POST — anyone who
reads the published `index.html` has the URL. Acceptable for low-stakes
collection, not if submissions are ever treated as trustworthy. Cheapest fix is
a shared secret header checked in the ingest Lambda; the real fix is a JWT
authorizer.

**Spend ceiling.** At the configured 5 req/s throttle the theoretical abuse
ceiling is ~13M submissions/month ≈ **$320**. Realistic volumes cost cents (see
below). The budget above alerts on it but does not stop it; lowering
`throttle_rate` would.

**Allowed origins.** `allowed_origins` defaults to
`https://vc.use-case-mapping.cdpi.dev` only; Pages enforces HTTPS, so plain
`http://` visitors are redirected before they can submit. Add
`http://localhost:<port>` in `terraform.tfvars` for local testing.

## Known gaps

- **PDF is uploaded as HTML, not PDF.** `printCase()` is `window.print()`, so
  the browser's print engine owns the output and its bytes never reach the
  page. The `export_pdf` trigger uploads a self-contained HTML snapshot of the
  print report instead — same content, before rasterisation. Producing a real
  PDF means adding jsPDF and rebuilding the print layout against it. Separate
  piece of work; not a small one.
- **No retry on submission failure.** A failed POST is recorded in
  `localStorage` under `vc-uc-cdpi-log` and never retried. A user who exports
  while offline loses that submission silently — they still get their file, so
  nothing looks wrong to them. A retry-on-next-load pass would close this.
- **No dedupe.** Exporting the same case four times produces four submissions.
  Intentional — each carries its own trigger and timestamp — but consumers need
  to group by `caseId` rather than assume one submission per case.
- **Payload ceiling.** Attachments are capped at 3 MiB decoded, 1 per
  submission (`max_file_bytes`, `max_files_per_submission`). Base64 inflates
  ~33%, and Lambda hard-caps a synchronous request at 6 MB (tighter than API
  Gateway's 10 MB). Typical exports are tens of
  KB, so there is comfortable headroom, but a very large case would be rejected
  client-side by `cdpiFile()` returning `null` — the export still downloads, it
  just doesn't upload. Presigned direct-to-S3 uploads would remove the ceiling
  if it ever becomes a problem.
- **No alerting on notifier failure.** If Slack is misconfigured the error is
  logged and swallowed — submissions still land in S3, but nobody is told. A
  CloudWatch alarm on the notifier's error metric would cover it.

## Cost

Unit prices fetched from the AWS Pricing API for `ap-south-1`. Each submission
is 1 API Gateway request + 2 Lambda invocations + 3 S3 PUTs + 1 S3 GET +
~100 KB stored ≈ **$0.0000246**.

| Submissions/month | Requests + compute | Storage (1st month) | Total |
| --- | --- | --- | --- |
| 100 | $0.003 | $0.0002 | ~$0.01 |
| 1,000 | $0.025 | $0.002 | ~$0.03 |
| 10,000 | $0.25 | $0.02 | ~$0.27 |
| 100,000 | $2.46 | $0.24 | ~$2.70 |

**Idle cost is $0.00** — no NAT gateway, load balancer or provisioned capacity,
so an unused month bills nothing. Lambda's free tier is perpetual and covers
all of the above; S3 and API Gateway free tiers cover the first 12 months.
Storage is the only part that accumulates: ~1.2 GB after a year at 1,000/month,
about $0.03/month.

Lambda *duration* is estimated (~600 ms ingest, ~500 ms notifier); request and
storage counts are exact.

## File map

| Path | What it is |
| --- | --- |
| `index.html` | The tool. Submission code is the `CDPI SUBMISSION` block. |
| `infra/main.tf` | Bucket, Lambdas, HTTP API, IAM, S3 notification, budget, state backend |
| `infra/variables.tf` | Tunables — throttle, size caps, retention, origins |
| `infra/lambda/ingest/index.mjs` | Validates and writes a submission |
| `infra/lambda/notifier/index.mjs` | manifest.json → Slack message with signed view link |
| `infra/lambda/viewer/index.mjs` | `GET /view` — checks the signature, returns the case or the original file |
| `infra/README.md` | Architecture and deploy detail |
| `.github/workflows/deploy.yml` | Pages deploy on push to `main` |
