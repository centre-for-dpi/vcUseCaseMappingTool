// Serves a stored submission to the read-only viewer in the tool, behind the
// signed links the notifier posts to Slack:
//
//   GET /view?id=<prefix>&sig=<sig>              -> JSON: case + manifest summary
//   GET /view?id=<prefix>&sig=<sig>&file=<name>  -> the original export, as a download
//
// <sig> is an HMAC of the prefix, so a link opens exactly one submission and
// nobody can list or guess others. Rotating VIEW_SIGNING_KEY revokes every link.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET;
const KEY = process.env.VIEW_SIGNING_KEY;

// Same shape the ingest Lambda writes; anything else is rejected before S3.
const PREFIX_RE = /^submissions\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]{1,80}$/;

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function validSig(prefix, sig) {
  const expected = createHmac('sha256', KEY).update(prefix).digest('base64url');
  const a = Buffer.from(String(sig || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function getObject(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { bytes: Buffer.from(await res.Body.transformToByteArray()), contentType: res.ContentType };
}

export const handler = async (event) => {
  const q = event.queryStringParameters || {};
  const prefix = String(q.id || '');
  if (!KEY || !PREFIX_RE.test(prefix) || !validSig(prefix, q.sig)) {
    return reply(403, { ok: false, error: 'invalid_link' });
  }

  let manifest;
  try {
    manifest = JSON.parse((await getObject(`${prefix}/manifest.json`)).bytes.toString('utf8'));
  } catch (err) {
    if (err.name === 'NoSuchKey') return reply(404, { ok: false, error: 'not_found' });
    throw err;
  }
  const files = manifest.files || [];

  if (q.file) {
    // Only files the manifest lists, so the name cannot reach other keys.
    const f = files.find((x) => x.filename === q.file);
    if (!f) return reply(404, { ok: false, error: 'file_not_found' });
    const obj = await getObject(f.key);
    return {
      statusCode: 200,
      headers: {
        'content-type': f.contentType || 'application/octet-stream',
        // Always a download: uploads come from an unauthenticated endpoint, so
        // stored HTML must never render on our origin.
        'content-disposition': `attachment; filename="${f.filename}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
      isBase64Encoded: true,
      body: obj.bytes.toString('base64'),
    };
  }

  const caseObj = JSON.parse((await getObject(`${prefix}/case.json`)).bytes.toString('utf8'));
  return reply(200, {
    ok: true,
    submissionId: manifest.submissionId,
    trigger: manifest.trigger,
    caseName: manifest.caseName,
    country: manifest.country,
    submitterRole: manifest.submitterRole,
    submittedAt: manifest.submittedAt,
    receivedAt: manifest.receivedAt,
    files: files.map((f) => ({ filename: f.filename, contentType: f.contentType, bytes: f.bytes })),
    case: caseObj,
  });
};
