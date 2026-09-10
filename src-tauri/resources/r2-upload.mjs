import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const result = { files: [], manifests: [], bucket: "", prefix: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--file") {
      if (!value) fail("R2_UPLOAD_ARGS_INVALID: --file requires a value");
      result.files.push(value);
      index += 1;
    } else if (key === "--manifest") {
      if (!value) fail("R2_UPLOAD_ARGS_INVALID: --manifest requires a value");
      result.manifests.push(value);
      index += 1;
    } else if (key === "--bucket") {
      if (!value) fail("R2_UPLOAD_ARGS_INVALID: --bucket requires a value");
      result.bucket = value;
      index += 1;
    } else if (key === "--prefix") {
      result.prefix = value || "";
      index += 1;
    } else {
      fail(`R2_UPLOAD_ARGS_INVALID: unknown argument ${key}`);
    }
  }
  if (!result.bucket || result.files.length === 0) {
    fail("R2_UPLOAD_ARGS_INVALID: bucket and at least one file are required");
  }
  return result;
}

function wildcard(pattern, value) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\?/g, ".")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(bucket, key) {
  return `/${awsEncode(bucket)}/${key.split("/").map(awsEncode).join("/")}`;
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

async function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function uploadFile({ accountId, accessKeyId, secretAccessKey, bucket, prefix, file }) {
  const fileName = basename(file);
  const key = [prefix.replace(/^\/+|\/+$/g, ""), fileName].filter(Boolean).join("/");
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`R2_KEY_INVALID: ${key}`);
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const uri = canonicalPath(bucket, key);
  const url = `https://${host}${uri}`;
  const now = new Date();
  const timestamp = amzDate(now);
  const datestamp = timestamp.slice(0, 8);
  const payloadHash = await fileSha256(file);
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${timestamp}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["PUT", uri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${datestamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), datestamp);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const info = await stat(file);
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      authorization,
      "content-length": String(info.size),
      "content-type": "application/octet-stream",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
    },
    body: createReadStream(file),
    duplex: "half",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`R2_UPLOAD_HTTP_${response.status}: ${fileName}${body ? ` - ${body.slice(0, 500)}` : ""}`);
  }
  console.log(`[r2] uploaded ${fileName} -> r2://${bucket}/${key}`);
}

const args = parseArgs(process.argv.slice(2));
const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accountId || !accessKeyId || !secretAccessKey) {
  fail("R2_CREDENTIAL_MISSING: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY");
}

const isManifest = (file) => args.manifests.some((pattern) => wildcard(pattern, basename(file)));
const ordered = [
  ...args.files.filter((file) => !isManifest(file)),
  ...args.files.filter(isManifest),
];

try {
  for (const file of ordered) {
    await uploadFile({
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket: args.bucket,
      prefix: args.prefix,
      file,
    });
  }
  console.log(`[r2] publish complete (${ordered.length} files; manifest uploaded last)`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
