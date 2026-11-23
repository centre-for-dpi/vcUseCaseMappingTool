// Receives a use-case export from the browser and lays it down in S3 as:
//
//   submissions/<YYYY>/<MM>/<DD>/<submissionId>/case.json
//   submissions/<YYYY>/<MM>/<DD>/<submissionId>/files/<filename>
//   submissions/<YYYY>/<MM>/<DD>/<submissionId>/manifest.json   <- written LAST
//
// manifest.json is written last on purpose: the S3 notification that drives the
// Slack message is filtered to that suffix, so a submission produces exactly one
// message and only once every file is already durable.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET;
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 3145728);
const MAX_FILES = Number(process.env.MAX_FILES || 1);

const ALLOWED_CONTENT_TYPES = new Set([
  'application/json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'text/html',
  'text/csv',
]);

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Strip anything that could escape the submission prefix or confuse S3.
function safeName(name, fallback) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 120);
  return cleaned || fallback;
}

function slug(value, fallback) {
  const s = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || fallback;
}

export const handler = async (event) => {
  let payload;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : event.body || '';
    payload = JSON.parse(raw);
  } catch {
    return reply(400, { ok: false, error: 'invalid_json' });
  }

  if (!payload || typeof payload !== 'object' || !payload.case) {
    return reply(400, { ok: false, error: 'missing_case' });
  }

  const files = Array.isArray(payload.files) ? payload.files : [];
  if (files.length > MAX_FILES) {
    return reply(413, { ok: false, error: 'too_many_files', max: MAX_FILES });
  }

  // Decode and validate every attachment before writing anything, so a bad
  // file cannot leave a half-written submission behind.
  const decoded = [];
  for (const f of files) {
    if (!f || typeof f.data !== 'string') {
      return reply(400, { ok: false, error: 'invalid_file_entry' });
    }
    const contentType = String(f.contentType || 'application/octet-stream');
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return reply(415, { ok: false, error: 'unsupported_content_type', contentType });
    }
    let bytes;
    try {
      bytes = Buffer.from(f.data, 'base64');
    } catch {
      return reply(400, { ok: false, error: 'invalid_base64' });
    }
    if (bytes.length > MAX_FILE_BYTES) {
      return reply(413, { ok: false, error: 'file_too_large', max: MAX_FILE_BYTES });
    }
    decoded.push({
      filename: safeName(f.filename, `attachment-${decoded.length + 1}`),
      contentType,
      bytes,
    });
  }

  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const caseId = slug(payload.caseId, 'case');
  const submissionId = `${caseId}-${now.getTime()}`;
  const prefix = `submissions/${yyyy}/${mm}/${dd}/${submissionId}`;

  const caseJson = Buffer.from(JSON.stringify(payload.case, null, 2), 'utf8');

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${prefix}/case.json`,
    Body: caseJson,
    ContentType: 'application/json',
  }));

  const written = [];
  for (const f of decoded) {
    const key = `${prefix}/files/${f.filename}`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: f.bytes,
      ContentType: f.contentType,
    }));
    written.push({ key, filename: f.filename, contentType: f.contentType, bytes: f.bytes.length });
  }

  const manifest = {
    schema: 'cdpi.usecase.submission.v1',
    submissionId,
    prefix,
    caseId: payload.caseId || null,
    caseName: payload.caseName || payload.case?.name || null,
    country: payload.case?.country || null,
    submitterRole: payload.submitterRole || null,
    trigger: payload.trigger || 'unknown',
    submittedAt: payload.submittedAt || now.toISOString(),
    receivedAt: now.toISOString(),
    caseKey: `${prefix}/case.json`,
    files: written,
    sourceIp: event.requestContext?.http?.sourceIp || null,
    userAgent: event.headers?.['user-agent'] || null,
  };

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${prefix}/manifest.json`,
    Body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    ContentType: 'application/json',
  }));

  return reply(200, { ok: true, submissionId, prefix, files: written.length });
};
