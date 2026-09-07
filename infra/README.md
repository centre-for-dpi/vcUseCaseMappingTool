# Submission pipeline

Every export in the tool posts the case JSON plus the exported file to an HTTP
endpoint, which lands them in S3 and announces them in Slack.

```
browser export
   │  POST {case, files[]}   (CDPI_SUBMIT_ENDPOINT)
   ▼
API Gateway (HTTP API, CORS-locked, throttled)
   ▼
ingest Lambda ──► s3://<bucket>/submissions/YYYY/MM/DD/<submissionId>/
                     ├── case.json
                     ├── files/<export>.xlsx | .json | .html
                     └── manifest.json          ← written last
                                │  ObjectCreated (suffix manifest.json)
                                ▼
                          notifier Lambda ──► Slack incoming webhook
```

`manifest.json` is written **last** and is the only key the S3 notification
matches. That gives exactly one Slack message per submission, fired only once
every file in it is durable.

## Deploy

```sh
cp terraform.tfvars.example terraform.tfvars   # add your Slack webhook
terraform init
terraform plan
terraform apply
```

Then copy the endpoint into the tool:

```sh
terraform output -raw submit_endpoint
```

and set it as `CDPI_SUBMIT_ENDPOINT` near the top of the submission block in
`../index.html`. Until it is set, the tool skips submission silently and keeps
working offline.

## What each trigger uploads

| Trigger        | Fired by             | Attachment                      |
| -------------- | -------------------- | ------------------------------- |
| `finish`       | Finish & export      | none — case JSON only           |
| `export_json`  | JSON export          | `.json`                         |
| `export_excel` | Excel export         | `.xlsx`                         |
| `export_pdf`   | PDF / print          | `.html` snapshot of the report  |

The PDF is produced by the browser's own print engine, so its bytes are never
available to the page. The `export_pdf` trigger therefore uploads a
self-contained HTML snapshot of the print report — the same content, before the
browser rasterises it. Generating a real PDF client-side would mean adding
jsPDF and re-doing the print layout against it.

## Notes

- The endpoint is **unauthenticated**. Its protection is the CORS origin
  allowlist plus API Gateway throttling (`throttle_rate` / `throttle_burst`).
  CORS stops other sites' pages from posting; it does not stop a direct
  scripted POST. If submissions ever need to be trusted, put a shared secret
  header or Cognito/JWT authorizer in front of the route.
- `slack_webhook_url` is a sensitive variable but still lands in Terraform
  state. Keep `terraform.tfstate` out of git (it is gitignored here) or move to
  an encrypted remote backend before this goes anywhere shared.
- The bucket blocks all public access; the ingest Lambda is the only writer and
  it can only write under `submissions/`.
