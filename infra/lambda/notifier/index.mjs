// Fires on submissions/**/manifest.json and posts one Slack message per
// submission. Slack failures are logged and swallowed: a broken webhook must
// never make a submission look failed, the objects are already durable.

import { createHmac } from 'node:crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const SITE_URL = process.env.SITE_URL;
const VIEW_KEY = process.env.VIEW_SIGNING_KEY;

const TRIGGER_LABELS = {
  finish: 'Finished case',
  export_json: 'Exported JSON',
  export_excel: 'Exported Excel',
  export_pdf: 'Exported PDF',
};

function fmtBytes(n) {
  if (!n && n !== 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Submissions come from an unauthenticated endpoint, so every user-supplied
// value is escaped before it reaches mrkdwn: otherwise a case named
// "<!channel>" pings the whole channel, and "<url|text>" forges a link.
function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Signed link into the tool's read-only viewer; the viewer Lambda checks the
// same HMAC. The token sits in the #fragment so it never reaches Pages logs.
function viewUrl(prefix) {
  if (!SITE_URL || !VIEW_KEY) return null;
  const sig = createHmac('sha256', VIEW_KEY).update(prefix).digest('base64url');
  return `${SITE_URL}/#view=${encodeURIComponent(prefix)}&sig=${sig}`;
}

async function readManifest(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await res.Body.transformToString());
}

function buildMessage(m, bucket, region) {
  const name = esc(m.caseName || m.caseId || m.submissionId);
  const trigger = esc(TRIGGER_LABELS[m.trigger] || m.trigger || 'Submission');
  const details = [
    m.country ? `*Country:* ${esc(m.country)}` : null,
    m.submitterRole ? `*Role:* ${esc(m.submitterRole)}` : null,
    `*Trigger:* ${trigger}`,
    `*Received:* ${esc(m.receivedAt)}`,
  ].filter(Boolean).join('\n');

  const fileLines = (m.files || []).length
    ? m.files.map((f) => `• \`${esc(f.filename)}\` (${fmtBytes(f.bytes)})`).join('\n')
    : '_case.json only — no attachment for this trigger_';

  const consoleUrl =
    `https://${region}.console.aws.amazon.com/s3/buckets/${bucket}?region=${region}` +
    `&prefix=${encodeURIComponent(m.prefix + '/')}`;

  const view = viewUrl(m.prefix);

  return {
    text: `New use case submission: ${name}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `📥 New use case submission`, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${name}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: details } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Files*\n${fileLines}` } },
      view && {
        type: 'actions',
        elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'View use case' }, url: view }],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `<${consoleUrl}|Open in S3> · \`${m.prefix}\`` }],
      },
    ].filter(Boolean),
  };
}

export const handler = async (event) => {
  if (!WEBHOOK) {
    console.warn('SLACK_WEBHOOK_URL not set; skipping notification');
    return;
  }
  const region = process.env.AWS_REGION;

  for (const record of event.Records || []) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    try {
      const manifest = await readManifest(bucket, key);
      const res = await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildMessage(manifest, bucket, region)),
      });
      if (!res.ok) {
        console.error('slack_post_failed', res.status, await res.text());
      }
    } catch (err) {
      console.error('notify_failed', key, err);
    }
  }
};
