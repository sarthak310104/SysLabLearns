import { arn, text, UsageError, type Call, type Service } from "./cli";
import { AwsError, byteLength, iso, md5, now, REGION, type AwsState, type S3Bucket, type S3Object } from "./state";
import { safeParse, statements, wildcard } from "./iam-eval";

/** Names other AWS customers already own: bucket names are global across every account. */
const TAKEN = new Set(["test", "data", "images", "backup", "backups", "photos", "logs", "files", "aws", "amazon", "bucket", "example", "my-bucket", "mybucket", "website", "static", "uploads", "media"]);

const S3_URI = /^s3:\/\/([^/]+)\/?(.*)$/;

function parseUri(uri: string): { bucket: string; key: string } | null {
  const m = uri.match(S3_URI);
  return m ? { bucket: m[1], key: m[2] } : null;
}

function validName(name: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) && !name.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(name);
}

function getBucket(c: Call, name: string): S3Bucket {
  const b = c.state.s3.buckets[name];
  if (!b) throw c.error("NoSuchBucket", "The specified bucket does not exist");
  return b;
}

const etagOf = (body: string) => `"${md5(body)}"`;

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      txt: "text/plain",
      html: "text/html",
      css: "text/css",
      js: "text/javascript",
      mjs: "text/javascript",
      json: "application/json",
      csv: "text/csv",
      md: "text/markdown",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      svg: "image/svg+xml",
      zip: "application/zip",
    }[ext] ?? "binary/octet-stream"
  );
}

function putObject(state: AwsState, b: S3Bucket, key: string, body: string, contentType: string): S3Object {
  const obj: S3Object = { body, size: byteLength(body), contentType, lastModified: now(state), etag: etagOf(body) };
  if (b.versioning === "Enabled") {
    obj.versionId = md5(key + now(state) + state.seq++).slice(0, 32);
    const prev = b.objects[key];
    if (prev) {
      b.versions ??= {};
      (b.versions[key] ??= []).push(prev);
    }
  }
  b.objects[key] = obj;
  return obj;
}

function deleteObject(b: S3Bucket, key: string): void {
  const prev = b.objects[key];
  if (prev && b.versioning === "Enabled") {
    b.versions ??= {};
    (b.versions[key] ??= []).push(prev);
  }
  delete b.objects[key];
}

const pad2 = (n: number) => String(n).padStart(2, "0");
function localTime(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function human(n: number): string {
  if (n < 1024) return `${n} Bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function createBucket(c: Call, name: string, locationGiven: string | undefined, highLevel: boolean): void {
  c.authorize("s3:CreateBucket", arn.s3Bucket(name));
  if (!validName(name)) throw c.error("InvalidBucketName", "The specified bucket is not valid.");
  if (c.state.s3.buckets[name]) {
    throw c.error("BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.");
  }
  if (TAKEN.has(name)) {
    throw c.error(
      "BucketAlreadyExists",
      "The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.",
    );
  }
  // Outside us-east-1, the low-level API needs the region spelled out. `aws s3 mb` adds it for you.
  if (!highLevel && locationGiven === undefined) {
    throw c.error("IllegalLocationConstraintException", `The unspecified location constraint is incompatible for the region specific endpoint this request was sent to.`);
  }
  if (locationGiven !== undefined && locationGiven !== REGION) {
    throw c.error("IllegalLocationConstraintException", `The ${locationGiven} location constraint is incompatible for the region specific endpoint this request was sent to.`);
  }
  c.state.s3.buckets[name] = {
    name,
    region: REGION,
    createdAt: now(c.state),
    objects: {},
    publicAccessBlock: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  };
}

/** Is this a policy that grants access to everyone (Principal "*")? */
function isPublicPolicy(doc: string): boolean {
  const d = safeParse(doc);
  if (!d) return false;
  return statements(d).some((st) => st.Effect === "Allow" && (st.Principal === "*" || (st.Principal as { AWS?: unknown })?.AWS === "*"));
}

/** Anonymous access through a bucket policy, as used by `curl https://bucket.s3...`. */
export function publicCanRead(b: S3Bucket, key: string): boolean {
  if (!b.policy || b.publicAccessBlock.RestrictPublicBuckets) return false;
  const d = safeParse(b.policy);
  if (!d) return false;
  const res = arn.s3Object(b.name, key);
  let allowed = false;
  for (const st of statements(d)) {
    const pub = st.Principal === "*" || (st.Principal as { AWS?: unknown })?.AWS === "*";
    if (!pub) continue;
    const actions = Array.isArray(st.Action) ? st.Action : [st.Action ?? ""];
    const resources = Array.isArray(st.Resource) ? st.Resource : [st.Resource ?? ""];
    if (!actions.some((a) => wildcard(a, "s3:GetObject", true))) continue;
    if (!resources.some((r) => wildcard(r, res))) continue;
    if (st.Effect === "Deny") return false;
    allowed = true;
  }
  return allowed;
}

/* ------------------------------------------------------------------ */
/* Presigned URLs                                                      */
/* ------------------------------------------------------------------ */

const SECRET = "lab-secret-key";
function amzDate(t: number): string {
  return new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
export function signature(bucket: string, key: string, date: string, expires: number, user: string): string {
  return md5(`${bucket}/${key}/${date}/${expires}/${user}/${SECRET}`) + md5(`${SECRET}/${user}/${expires}/${date}/${key}/${bucket}`);
}

export function presign(state: AwsState, bucket: string, key: string, expires: number, user: string): string {
  const date = amzDate(now(state));
  const day = date.slice(0, 8);
  const cred = encodeURIComponent(`LAB${user.toUpperCase()}/${day}/${REGION}/s3/aws4_request`);
  const q = [
    "X-Amz-Algorithm=AWS4-HMAC-SHA256",
    `X-Amz-Credential=${cred}`,
    `X-Amz-Date=${date}`,
    `X-Amz-Expires=${expires}`,
    "X-Amz-SignedHeaders=host",
    `X-Amz-Signature=${signature(bucket, key, date, expires, user)}`,
  ].join("&");
  return `https://${bucket}.s3.${REGION}.amazonaws.com/${key.split("/").map(encodeURIComponent).join("/")}?${q}`;
}

/* ------------------------------------------------------------------ */
/* `aws s3`: the friendly commands                                     */
/* ------------------------------------------------------------------ */

function listLocal(c: Call, dir: string): string[] {
  const root = c.io.resolve(dir).replace(/\/$/, "") + "/";
  return Object.keys((c.state as AwsState).files).filter((f) => f.startsWith(root) && !f.endsWith("/"));
}

async function s3cp(c: Call, move: boolean): Promise<unknown> {
  const [src, dst] = c.positionals;
  if (!src || !dst) throw new UsageError("the following arguments are required: paths");
  const verb = move ? "move" : "copy";
  const s = parseUri(src);
  const d = parseUri(dst);
  const lines: string[] = [];
  const recursive = c.bool("recursive");
  const ctype = c.str("content-type");

  if (!s && d) {
    // Upload
    const b = getBucketFor(c, d.bucket, "s3:PutObject");
    const files = recursive ? listLocal(c, src) : [c.io.resolve(src)];
    if (!recursive && !c.io.exists(src)) throw new UsageError(`\nThe user-provided path ${src} does not exist.`);
    if (recursive && !files.length) return text("");
    for (const f of files) {
      const rel = recursive ? f.slice(c.io.resolve(src).replace(/\/$/, "").length + 1) : f.split("/").pop()!;
      const key = recursive ? (d.key ? d.key.replace(/\/$/, "") + "/" : "") + rel : !d.key || d.key.endsWith("/") ? d.key + rel : d.key;
      c.authorize("s3:PutObject", arn.s3Object(b.name, key));
      putObject(c.state, b, key, c.io.readFile(f), ctype ?? contentTypeFor(f));
      const shown = recursive ? `${src.replace(/\/$/, "")}/${rel}` : src.startsWith("/") || src.startsWith("~") || src.startsWith(".") ? src : `./${src}`;
      lines.push(`${move ? "move" : "upload"}: ${shown} to s3://${b.name}/${key}`);
      if (move) delete c.state.files[f];
    }
    return text(lines.join("\n") + "\n");
  }
  if (s && !d) {
    // Download
    const b = getBucketFor(c, s.bucket, "s3:GetObject");
    const keys = recursive ? Object.keys(b.objects).filter((k) => k.startsWith(s.key)) : [s.key];
    for (const key of keys) {
      c.authorize("s3:GetObject", arn.s3Object(b.name, key));
      const obj = b.objects[key];
      if (!obj) {
        return text(`fatal error: An error occurred (404) when calling the HeadObject operation: Key "${key}" does not exist\n`);
      }
      const rel = recursive ? key.slice(s.key.length).replace(/^\//, "") : key.split("/").pop()!;
      const target = recursive ? `${dst.replace(/\/$/, "")}/${rel}` : dst.endsWith("/") || dst === "." ? `${dst.replace(/\/$/, "")}/${rel}`.replace(/^\.\//, "./") : dst;
      c.io.writeFile(target, obj.body);
      lines.push(`${move ? "move" : "download"}: s3://${b.name}/${key} to ${target.startsWith("/") || target.startsWith(".") ? target : "./" + target}`);
      if (move) deleteObject(b, key);
    }
    return text(lines.join("\n") + (lines.length ? "\n" : ""));
  }
  if (s && d) {
    const from = getBucketFor(c, s.bucket, "s3:GetObject");
    const to = getBucketFor(c, d.bucket, "s3:PutObject");
    const keys = recursive ? Object.keys(from.objects).filter((k) => k.startsWith(s.key)) : [s.key];
    for (const key of keys) {
      const obj = from.objects[key];
      if (!obj) throw c.error("404", `Key "${key}" does not exist`);
      const rel = recursive ? key.slice(s.key.length).replace(/^\//, "") : key.split("/").pop()!;
      const nk = recursive ? (d.key ? d.key.replace(/\/$/, "") + "/" : "") + rel : !d.key || d.key.endsWith("/") ? d.key + rel : d.key;
      c.authorize("s3:GetObject", arn.s3Object(from.name, key));
      c.authorize("s3:PutObject", arn.s3Object(to.name, nk));
      putObject(c.state, to, nk, obj.body, obj.contentType);
      if (move) deleteObject(from, key);
      lines.push(`${verb}: s3://${from.name}/${key} to s3://${to.name}/${nk}`);
    }
    return text(lines.join("\n") + "\n");
  }
  throw new UsageError(`Error: Invalid argument type. Use s3://bucket/key for S3 paths.`);
}

function getBucketFor(c: Call, name: string, action: string): S3Bucket {
  const b = c.state.s3.buckets[name];
  if (!b) {
    c.authorize(action, arn.s3Bucket(name) + (action.includes("Object") ? "/*" : ""));
    throw c.error("NoSuchBucket", "The specified bucket does not exist");
  }
  return b;
}

const s3: Service = {
  blurb: "Simple Storage Service: store files (objects) in buckets",
  help: "High-level commands. For the full API, see: aws s3api help",
  commands: {
    mb: (c) => {
      const p = parseUri(c.positionals[0] ?? "");
      if (!p) throw new UsageError("the following arguments are required: path (like s3://my-bucket-name)");
      try {
        createBucket(c, p.bucket, undefined, true);
      } catch (e) {
        if (e instanceof AwsError) return text(`make_bucket failed: s3://${p.bucket} An error occurred (${e.code}) when calling the CreateBucket operation: ${e.message}\n`);
        throw e;
      }
      return text(`make_bucket: ${p.bucket}\n`);
    },
    rb: (c) => {
      const p = parseUri(c.positionals[0] ?? "");
      if (!p) throw new UsageError("the following arguments are required: path");
      const b = c.state.s3.buckets[p.bucket];
      const fail = (code: string, msg: string) => text(`remove_bucket failed: s3://${p.bucket} An error occurred (${code}) when calling the DeleteBucket operation: ${msg}\n`);
      if (!b) return fail("NoSuchBucket", "The specified bucket does not exist");
      c.authorize("s3:DeleteBucket", arn.s3Bucket(b.name));
      const lines: string[] = [];
      if (c.bool("force")) {
        for (const k of Object.keys(b.objects)) lines.push(`delete: s3://${b.name}/${k}`);
        b.objects = {};
        b.versions = {};
      }
      if (Object.keys(b.objects).length) return fail("BucketNotEmpty", "The bucket you tried to delete is not empty");
      delete c.state.s3.buckets[b.name];
      lines.push(`remove_bucket: ${b.name}`);
      return text(lines.join("\n") + "\n");
    },
    ls: (c) => {
      const target = c.positionals[0];
      if (!target) {
        c.authorize("s3:ListAllMyBuckets", "*");
        return text(
          Object.values(c.state.s3.buckets)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((b) => `${localTime(b.createdAt)} ${b.name}`)
            .join("\n") + (Object.keys(c.state.s3.buckets).length ? "\n" : ""),
        );
      }
      const p = parseUri(target);
      if (!p) throw new UsageError(`Invalid path: ${target}`);
      const b = getBucketFor(c, p.bucket, "s3:ListBucket");
      c.authorize("s3:ListBucket", arn.s3Bucket(b.name));
      const keys = Object.keys(b.objects).sort().filter((k) => k.startsWith(p.key));
      const hr = c.bool("human-readable");
      const size = (n: number) => (hr ? human(n).padStart(10) : String(n).padStart(10));
      const lines: string[] = [];
      let total = 0;
      if (c.bool("recursive")) {
        for (const k of keys) {
          const o = b.objects[k];
          total += o.size;
          lines.push(`${localTime(o.lastModified)} ${size(o.size)} ${k}`);
        }
      } else {
        const prefix = p.key && !p.key.endsWith("/") && keys.some((k) => k.startsWith(p.key + "/")) ? p.key + "/" : p.key;
        const seen = new Set<string>();
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash >= 0) {
            const dir = rest.slice(0, slash + 1);
            if (!seen.has(dir)) lines.push(`${"PRE".padStart(30)} ${dir}`);
            seen.add(dir);
          } else {
            const o = b.objects[k];
            total += o.size;
            lines.push(`${localTime(o.lastModified)} ${size(o.size)} ${rest}`);
          }
        }
      }
      if (c.bool("summarize")) lines.push("", `Total Objects: ${keys.length}`, `   Total Size: ${hr ? human(total) : total}`);
      return text(lines.join("\n") + (lines.length ? "\n" : ""));
    },
    cp: (c) => s3cp(c, false),
    mv: (c) => s3cp(c, true),
    rm: (c) => {
      const p = parseUri(c.positionals[0] ?? "");
      if (!p) throw new UsageError("the following arguments are required: paths");
      const b = getBucketFor(c, p.bucket, "s3:DeleteObject");
      const keys = c.bool("recursive") ? Object.keys(b.objects).filter((k) => k.startsWith(p.key)) : [p.key];
      const lines: string[] = [];
      for (const k of keys) {
        c.authorize("s3:DeleteObject", arn.s3Object(b.name, k));
        deleteObject(b, k);
        lines.push(`delete: s3://${b.name}/${k}`);
      }
      return text(lines.join("\n") + "\n");
    },
    sync: (c) => {
      const [src, dst] = c.positionals;
      const d = parseUri(dst ?? "");
      if (!src || !d) throw new UsageError("aws s3 sync <local-folder> s3://bucket/prefix (this lab supports uploading)");
      const b = getBucketFor(c, d.bucket, "s3:PutObject");
      const root = c.io.resolve(src).replace(/\/$/, "");
      const lines: string[] = [];
      for (const f of listLocal(c, src)) {
        const rel = f.slice(root.length + 1);
        const key = (d.key ? d.key.replace(/\/$/, "") + "/" : "") + rel;
        const body = c.io.readFile(f);
        if (b.objects[key]?.etag === etagOf(body)) continue; // unchanged: sync skips it
        c.authorize("s3:PutObject", arn.s3Object(b.name, key));
        putObject(c.state, b, key, body, contentTypeFor(f));
        lines.push(`upload: ${src.replace(/\/$/, "")}/${rel} to s3://${b.name}/${key}`);
      }
      if (c.bool("delete")) {
        const prefix = d.key ? d.key.replace(/\/$/, "") + "/" : "";
        const local = new Set(listLocal(c, src).map((f) => prefix + f.slice(root.length + 1)));
        for (const k of Object.keys(b.objects)) {
          if (k.startsWith(prefix) && !local.has(k)) {
            deleteObject(b, k);
            lines.push(`delete: s3://${b.name}/${k}`);
          }
        }
      }
      return text(lines.join("\n") + (lines.length ? "\n" : ""));
    },
    presign: (c) => {
      const p = parseUri(c.positionals[0] ?? "");
      if (!p || !p.key) throw new UsageError("the following arguments are required: path (s3://bucket/key)");
      const exp = c.int("expires-in", 3600)!;
      if (exp > 604800) throw new UsageError("Error parsing parameter '--expires-in': the maximum is 604800 seconds (7 days)");
      // Signing needs no network call: a URL is produced even if the object doesn't exist.
      return text(presign(c.state, p.bucket, p.key, exp, c.principal.name) + "\n");
    },
  },
};

/* ------------------------------------------------------------------ */
/* `aws s3api`: one command per API operation                          */
/* ------------------------------------------------------------------ */

function objectMeta(o: S3Object) {
  return {
    AcceptRanges: "bytes",
    LastModified: iso(o.lastModified),
    ContentLength: o.size,
    ETag: o.etag,
    ...(o.versionId ? { VersionId: o.versionId } : {}),
    ContentType: o.contentType,
    ServerSideEncryption: "AES256",
    Metadata: {},
  };
}

const s3api: Service = {
  blurb: "S3's full API, one command per operation",
  commands: {
    "create-bucket": (c) => {
      const name = c.str("bucket", true);
      const cfg = c.structured("create-bucket-configuration") as { LocationConstraint?: string } | undefined;
      createBucket(c, name, cfg?.LocationConstraint, false);
      return { Location: `http://${name}.s3.amazonaws.com/` };
    },
    "delete-bucket": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      c.authorize("s3:DeleteBucket", arn.s3Bucket(b.name));
      if (Object.keys(b.objects).length) throw c.error("BucketNotEmpty", "The bucket you tried to delete is not empty");
      delete c.state.s3.buckets[b.name];
    },
    "list-buckets": (c) => {
      c.authorize("s3:ListAllMyBuckets", "*");
      return {
        Buckets: Object.values(c.state.s3.buckets).map((b) => ({ Name: b.name, CreationDate: iso(b.createdAt) })),
        Owner: { DisplayName: "you", ID: md5("you") + md5("owner") },
        Prefix: null,
      };
    },
    "head-bucket": (c) => {
      const name = c.str("bucket", true);
      c.authorize("s3:ListBucket", arn.s3Bucket(name));
      if (!c.state.s3.buckets[name]) throw c.error("404", "Not Found");
      return { BucketRegion: REGION, AccessPointAlias: false };
    },
    "get-bucket-location": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      return { LocationConstraint: b.region };
    },
    "put-object": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      const key = c.str("key", true);
      c.authorize("s3:PutObject", arn.s3Object(b.name, key));
      const bodyPath = c.flags["body"];
      let body = "";
      if (Array.isArray(bodyPath)) {
        const p = bodyPath[0];
        if (!c.io.exists(p)) throw new UsageError(`Error parsing parameter '--body': Blob values must be a path to a file. File does not exist: ${p}`);
        body = c.io.readFile(p);
      }
      const o = putObject(c.state, b, key, body, c.str("content-type") ?? (Array.isArray(bodyPath) ? contentTypeFor(bodyPath[0]) : "binary/octet-stream"));
      return { ETag: o.etag, ServerSideEncryption: "AES256", ...(o.versionId ? { VersionId: o.versionId } : {}) };
    },
    "get-object": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      const key = c.str("key", true);
      const out = c.positionals[0];
      if (!out) throw new UsageError("the following arguments are required: outfile");
      c.authorize("s3:GetObject", arn.s3Object(b.name, key));
      const vid = c.str("version-id");
      const o = vid ? [...(b.versions?.[key] ?? []), b.objects[key]].find((x) => x?.versionId === vid) : b.objects[key];
      if (!o) throw c.error("NoSuchKey", "The specified key does not exist.");
      c.io.writeFile(out, o.body);
      return objectMeta(o);
    },
    "head-object": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      const key = c.str("key", true);
      c.authorize("s3:GetObject", arn.s3Object(b.name, key));
      const o = b.objects[key];
      if (!o) throw c.error("404", "Not Found");
      return objectMeta(o);
    },
    "delete-object": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      const key = c.str("key", true);
      c.authorize("s3:DeleteObject", arn.s3Object(b.name, key));
      const had = b.objects[key];
      deleteObject(b, key);
      return b.versioning === "Enabled" && had ? { DeleteMarker: true, VersionId: md5(key + "dm").slice(0, 32) } : undefined;
    },
    "copy-object": (c) => {
      const to = getBucket(c, c.str("bucket", true));
      const key = c.str("key", true);
      const src = c.str("copy-source", true).replace(/^\//, "");
      const slash = src.indexOf("/");
      const from = getBucket(c, src.slice(0, slash));
      const sk = decodeURIComponent(src.slice(slash + 1));
      c.authorize("s3:GetObject", arn.s3Object(from.name, sk));
      c.authorize("s3:PutObject", arn.s3Object(to.name, key));
      const o = from.objects[sk];
      if (!o) throw c.error("NoSuchKey", "The specified key does not exist.");
      const n = putObject(c.state, to, key, o.body, o.contentType);
      return { CopyObjectResult: { ETag: n.etag, LastModified: iso(n.lastModified) } };
    },
    "list-objects-v2": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      c.authorize("s3:ListBucket", arn.s3Bucket(b.name));
      const prefix = c.str("prefix") ?? "";
      const delim = c.str("delimiter");
      const max = c.int("max-keys", 1000)!;
      const keys = Object.keys(b.objects).sort().filter((k) => k.startsWith(prefix));
      const contents: unknown[] = [];
      const prefixes = new Set<string>();
      for (const k of keys) {
        if (delim) {
          const rest = k.slice(prefix.length);
          const i = rest.indexOf(delim);
          if (i >= 0) {
            prefixes.add(prefix + rest.slice(0, i + 1));
            continue;
          }
        }
        const o = b.objects[k];
        contents.push({ Key: k, LastModified: iso(o.lastModified), ETag: o.etag, Size: o.size, StorageClass: "STANDARD" });
      }
      const shown = contents.slice(0, max);
      const out: Record<string, unknown> = {};
      if (shown.length) out.Contents = shown;
      if (prefixes.size) out.CommonPrefixes = [...prefixes].map((p) => ({ Prefix: p }));
      out.RequestCharged = null;
      out.Prefix = prefix;
      if (contents.length > max) out.IsTruncated = true;
      return out;
    },
    "put-bucket-policy": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      c.authorize("s3:PutBucketPolicy", arn.s3Bucket(b.name));
      const doc = c.str("policy", true);
      const parsed = safeParse(doc);
      if (!parsed) throw c.error("MalformedPolicy", "Policies must be valid JSON and the first byte must be '{'");
      for (const st of statements(parsed)) {
        const rs = Array.isArray(st.Resource) ? st.Resource : [st.Resource ?? ""];
        for (const r of rs) {
          if (!r.startsWith(`arn:aws:s3:::${b.name}`)) throw c.error("MalformedPolicy", "Policy has invalid resource");
        }
      }
      if (isPublicPolicy(doc) && b.publicAccessBlock.BlockPublicPolicy) {
        throw c.error(
          "AccessDenied",
          `User: ${c.principal.arn} is not authorized to perform: s3:PutBucketPolicy on resource: "arn:aws:s3:::${b.name}" because public policies are blocked by the BlockPublicPolicy block public access setting.`,
        );
      }
      b.policy = doc;
    },
    "get-bucket-policy": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      c.authorize("s3:GetBucketPolicy", arn.s3Bucket(b.name));
      if (!b.policy) throw c.error("NoSuchBucketPolicy", "The bucket policy does not exist");
      return { Policy: b.policy };
    },
    "delete-bucket-policy": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      c.authorize("s3:DeleteBucketPolicy", arn.s3Bucket(b.name));
      delete b.policy;
    },
    "put-public-access-block": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      c.authorize("s3:PutBucketPublicAccessBlock", arn.s3Bucket(b.name));
      const cfg = c.structured("public-access-block-configuration", true) as Record<string, unknown>;
      const flag = (k: string) => String(cfg[k]).toLowerCase() === "true";
      b.publicAccessBlock = { BlockPublicAcls: flag("BlockPublicAcls"), IgnorePublicAcls: flag("IgnorePublicAcls"), BlockPublicPolicy: flag("BlockPublicPolicy"), RestrictPublicBuckets: flag("RestrictPublicBuckets") };
    },
    "get-public-access-block": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      return { PublicAccessBlockConfiguration: b.publicAccessBlock };
    },
    "delete-public-access-block": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      c.authorize("s3:PutBucketPublicAccessBlock", arn.s3Bucket(b.name));
      b.publicAccessBlock = { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: false };
    },
    "put-bucket-versioning": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      c.authorize("s3:PutBucketVersioning", arn.s3Bucket(b.name));
      const cfg = c.structured("versioning-configuration", true) as { Status?: string };
      if (cfg.Status !== "Enabled" && cfg.Status !== "Suspended") throw c.error("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema");
      b.versioning = cfg.Status;
    },
    "get-bucket-versioning": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      return b.versioning ? { Status: b.versioning } : {};
    },
    "list-object-versions": (c) => {
      const b = getBucket(c, c.str("bucket", true));
      c.authorize("s3:ListBucketVersions", arn.s3Bucket(b.name));
      const prefix = c.str("prefix") ?? "";
      const versions: unknown[] = [];
      const keys = new Set([...Object.keys(b.objects), ...Object.keys(b.versions ?? {})]);
      for (const k of [...keys].sort()) {
        if (!k.startsWith(prefix)) continue;
        const cur = b.objects[k];
        if (cur) versions.push({ ETag: cur.etag, Size: cur.size, Key: k, VersionId: cur.versionId ?? "null", IsLatest: true, LastModified: iso(cur.lastModified) });
        for (const v of [...(b.versions?.[k] ?? [])].reverse()) {
          versions.push({ ETag: v.etag, Size: v.size, Key: k, VersionId: v.versionId ?? "null", IsLatest: false, LastModified: iso(v.lastModified) });
        }
      }
      return { Versions: versions, RequestCharged: null, Prefix: prefix };
    },
  },
};

export const S3_SERVICES = { s3, s3api };
