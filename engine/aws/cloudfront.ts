import { text, UsageError, type Call, type Service } from "./cli";
import { wildcard } from "./iam-eval";
import { cloudfrontCanRead, publicCanRead } from "./s3";
import { ACCOUNT_ID, iso, md5, nextId, now, REGION, type AwsState, type CfDistribution, type S3Bucket } from "./state";

/*
 * CloudFront in front of S3, and S3's own website endpoints. Enough to show
 * the real lessons: a website bucket must be public, CloudFront with an
 * origin access control lets it stay private, and cached copies outlive the
 * file you just uploaded until you invalidate them.
 */

const DEPLOY_MS = 3 * 60000;

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A host curl can't resolve yet (a distribution that hasn't deployed). */
export class NotResolvable extends Error {}

const upperId = (s: AwsState, n = 14) => ("E" + nextId(s, n + 4).toUpperCase().replace(/[^A-Z0-9]/g, "")).slice(0, n);

/* ---------------- S3 website endpoints ---------------- */

export const websiteHost = (bucket: string) => `${bucket}.s3-website.${REGION}.amazonaws.com`;

function htmlError(status: number, title: string, code: string, message: string, extra: string[] = []): HttpResponse {
  const id = md5(code + message + status).slice(0, 16).toUpperCase();
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", server: "AmazonS3" },
    body: `<html>\n<head><title>${status} ${title}</title></head>\n<body>\n<h1>${status} ${title}</h1>\n<ul>\n<li>Code: ${code}</li>\n<li>Message: ${message}</li>\n${extra.map((e) => `<li>${e}</li>\n`).join("")}<li>RequestId: ${id}</li>\n</ul>\n<hr/>\n</body>\n</html>\n`,
  };
}

/** What http://bucket.s3-website... returns: index documents, error documents, and only for public buckets. */
export function websiteHttp(state: AwsState, bucketName: string, path: string): HttpResponse {
  const b = state.s3.buckets[bucketName];
  if (!b) return htmlError(404, "Not Found", "NoSuchBucket", "The specified bucket does not exist", [`BucketName: ${bucketName}`]);
  if (!b.website) return htmlError(404, "Not Found", "NoSuchWebsiteConfiguration", "The specified bucket does not have a website configuration", [`BucketName: ${bucketName}`]);
  let key = decodeURIComponent(path.replace(/^\//, ""));
  if (key === "" || key.endsWith("/")) key += b.website.index;
  if (!publicCanRead(b, key)) return htmlError(403, "Forbidden", "AccessDenied", "Access Denied");
  const o = b.objects[key];
  if (o) return { status: 200, headers: { "content-type": o.contentType, etag: o.etag, server: "AmazonS3" }, body: o.body };
  const err = b.website.error ? b.objects[b.website.error] : undefined;
  if (err && publicCanRead(b, b.website.error!)) return { status: 404, headers: { "content-type": err.contentType, server: "AmazonS3" }, body: err.body };
  return htmlError(404, "Not Found", "NoSuchKey", "The specified key does not exist.", [`Key: ${key}`]);
}

/* ---------------- origins ---------------- */

/** Which bucket an origin domain points at, and whether it's the website endpoint. */
function originBucket(domain: string): { bucket: string; website: boolean } | null {
  let m = domain.match(/^(.+)\.s3-website[.-]([a-z0-9-]+\.)?amazonaws\.com$/);
  if (m) return { bucket: m[1], website: true };
  m = domain.match(/^(.+)\.s3(\.[a-z0-9-]+)?\.amazonaws\.com$/);
  if (m) return { bucket: m[1], website: false };
  return null;
}

function fromOrigin(state: AwsState, d: CfDistribution, key: string): HttpResponse {
  const o = originBucket(d.origin.domain);
  if (!o) return { status: 502, headers: { "content-type": "text/html" }, body: "<h1>502 Bad Gateway</h1><p>CloudFront couldn't connect to the origin.</p>\n" };
  if (o.website) return websiteHttp(state, o.bucket, "/" + key);
  const b: S3Bucket | undefined = state.s3.buckets[o.bucket];
  const xml = (status: number, code: string, message: string) => ({
    status,
    headers: { "content-type": "application/xml", server: "AmazonS3" },
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message></Error>`,
  });
  if (!b) return xml(404, "NoSuchBucket", "The specified bucket does not exist");
  // With an origin access control CloudFront signs its requests as itself; without one it asks anonymously.
  const allowed = d.origin.oacId ? cloudfrontCanRead(b, key, d.arn) : publicCanRead(b, key);
  if (!allowed) return xml(403, "AccessDenied", "Access Denied");
  const obj = b.objects[key];
  if (!obj) return xml(publicCanRead(b, key) ? 404 : 403, publicCanRead(b, key) ? "NoSuchKey" : "AccessDenied", publicCanRead(b, key) ? "The specified key does not exist." : "Access Denied");
  return { status: 200, headers: { "content-type": obj.contentType, etag: obj.etag }, body: obj.body };
}

/** A request to https://dxxxx.cloudfront.net/path. */
export function cloudfrontHttp(state: AwsState, host: string, path: string): HttpResponse {
  const d = Object.values(state.cloudfront.distributions).find((x) => x.domain === host);
  if (!d) throw new NotResolvable(`curl: (6) Could not resolve host: ${host}\n`);
  // Only the first rollout leaves the name unresolvable; later changes roll out while the old setup keeps serving.
  if (now(state) < d.createdAt + DEPLOY_MS) {
    throw new NotResolvable(`curl: (6) Could not resolve host: ${host}\n(The distribution is still deploying to edge locations. Try: aws cloudfront wait distribution-deployed --id ${d.id})\n`);
  }
  if (!d.enabled) return { status: 403, headers: { "content-type": "text/html" }, body: "<h1>403 ERROR</h1><p>The distribution is disabled.</p>\n" };
  let key = decodeURIComponent(path.replace(/^\//, ""));
  if (key === "" && d.defaultRootObject) key = d.defaultRootObject;
  const t = now(state);
  const pop = "BOM78-P1";
  const via = `1.1 ${md5(d.id).slice(0, 16)}.cloudfront.net (CloudFront)`;
  d.stats ??= { hits: 0, misses: 0 };
  const cached = d.cache["/" + key];
  if (cached && t - cached.at < d.defaultTtl * 1000) {
    d.stats.hits++;
    return { status: cached.status, headers: { "content-type": cached.contentType, "x-cache": "Hit from cloudfront", age: String(Math.floor((t - cached.at) / 1000)), via, "x-amz-cf-pop": pop }, body: cached.body };
  }
  d.stats.misses++;
  const r = fromOrigin(state, d, key);
  if (r.status === 200) d.cache["/" + key] = { body: r.body, contentType: r.headers["content-type"] ?? "binary/octet-stream", status: 200, at: t };
  return { ...r, headers: { ...r.headers, "x-cache": r.status === 200 ? "Miss from cloudfront" : "Error from cloudfront", via, "x-amz-cf-pop": pop } };
}

/* ---------------- the CLI ---------------- */

interface Config {
  CallerReference: string;
  Comment: string;
  Enabled: boolean;
  DefaultRootObject: string;
  Origins: { Quantity: number; Items: { Id: string; DomainName: string; OriginPath: string; S3OriginConfig?: { OriginAccessIdentity: string }; OriginAccessControlId: string }[] };
  DefaultCacheBehavior: { TargetOriginId: string; ViewerProtocolPolicy: string; MinTTL: number; DefaultTTL: number; MaxTTL: number };
  PriceClass: string;
}

function configOf(d: CfDistribution): Config {
  const s3 = originBucket(d.origin.domain);
  return {
    CallerReference: d.callerReference,
    Comment: d.comment,
    Enabled: d.enabled,
    DefaultRootObject: d.defaultRootObject,
    Origins: {
      Quantity: 1,
      Items: [{ Id: d.origin.id, DomainName: d.origin.domain, OriginPath: "", ...(s3 && !s3.website ? { S3OriginConfig: { OriginAccessIdentity: "" } } : {}), OriginAccessControlId: d.origin.oacId }],
    },
    DefaultCacheBehavior: { TargetOriginId: d.origin.id, ViewerProtocolPolicy: "redirect-to-https", MinTTL: 0, DefaultTTL: d.defaultTtl, MaxTTL: 31536000 },
    PriceClass: "PriceClass_All",
  };
}

function view(state: AwsState, d: CfDistribution) {
  return {
    Id: d.id,
    ARN: d.arn,
    Status: now(state) < d.deployedAt ? "InProgress" : "Deployed",
    LastModifiedTime: iso(d.createdAt),
    InProgressInvalidationBatches: 0,
    DomainName: d.domain,
    DistributionConfig: configOf(d),
  };
}

function need(c: Call, id: string | undefined): CfDistribution {
  if (!id) throw new UsageError("the following arguments are required: --id");
  const d = c.state.cloudfront.distributions[id];
  if (!d) throw c.error("NoSuchDistribution", "The specified distribution does not exist.");
  return d;
}

/** Read a DistributionConfig (from --distribution-config or the shortcut flags) into a distribution's fields. */
function applyConfig(c: Call, d: Partial<CfDistribution>, cfg: Partial<Config>): void {
  const item = cfg.Origins?.Items?.[0];
  if (!item?.DomainName) throw c.error("InvalidArgument", "The parameter Origins must contain at least one origin with a DomainName.");
  const ob = originBucket(item.DomainName);
  if (ob && !c.state.s3.buckets[ob.bucket]) throw c.error("InvalidOrigin", "The specified origin server does not exist or is not valid.");
  const oac = item.OriginAccessControlId ?? "";
  if (oac && !c.state.cloudfront.oacs[oac]) throw c.error("NoSuchOriginAccessControl", "The origin access control does not exist.");
  if (oac && ob?.website) throw c.error("IllegalOriginAccessConfiguration", "Origin access control can only be used with S3 bucket origins (not S3 website endpoints).");
  if (cfg.DefaultCacheBehavior && cfg.DefaultCacheBehavior.TargetOriginId !== item.Id) throw c.error("NoSuchOrigin", "One or more of your origins or origin groups do not exist.");
  d.origin = { id: item.Id ?? item.DomainName, domain: item.DomainName, oacId: oac };
  d.defaultRootObject = cfg.DefaultRootObject ?? "";
  d.enabled = cfg.Enabled ?? true;
  d.comment = cfg.Comment ?? "";
  d.defaultTtl = Number(cfg.DefaultCacheBehavior?.DefaultTTL ?? 86400);
  if (cfg.CallerReference) d.callerReference = cfg.CallerReference;
}

const cloudfront: Service = {
  blurb: "CloudFront: a CDN that caches your content close to users, worldwide",
  help: "Make a distribution: aws cloudfront create-distribution --origin-domain-name BUCKET.s3.ap-south-1.amazonaws.com --default-root-object index.html",
  commands: {
    "create-origin-access-control": (c) => {
      c.authorize("cloudfront:CreateOriginAccessControl", "*");
      const cfg = c.structured("origin-access-control-config", true) as Record<string, string>;
      for (const k of ["Name", "SigningProtocol", "SigningBehavior", "OriginAccessControlOriginType"]) {
        if (!cfg[k]) throw new UsageError(`Parameter validation failed:\nMissing required parameter in OriginAccessControlConfig: "${k}"`);
      }
      if (Object.values(c.state.cloudfront.oacs).some((o) => o.name === cfg.Name)) throw c.error("OriginAccessControlAlreadyExists", "An origin access control with the same name already exists.");
      const id = upperId(c.state);
      const o = { id, name: cfg.Name, etag: "E" + nextId(c.state, 12).toUpperCase(), signingBehavior: cfg.SigningBehavior, originType: cfg.OriginAccessControlOriginType };
      c.state.cloudfront.oacs[id] = o;
      return {
        Location: `https://cloudfront.amazonaws.com/2020-05-31/origin-access-control/${id}`,
        ETag: o.etag,
        OriginAccessControl: { Id: id, OriginAccessControlConfig: { Name: o.name, Description: cfg.Description ?? "", SigningProtocol: "sigv4", SigningBehavior: o.signingBehavior, OriginAccessControlOriginType: o.originType } },
      };
    },
    "list-origin-access-controls": (c) => {
      const items = Object.values(c.state.cloudfront.oacs).map((o) => ({ Id: o.id, Name: o.name, SigningProtocol: "sigv4", SigningBehavior: o.signingBehavior, OriginAccessControlOriginType: o.originType }));
      return { OriginAccessControlList: { Quantity: items.length, Items: items } };
    },
    "create-distribution": (c) => {
      c.authorize("cloudfront:CreateDistribution", "*");
      let cfg: Partial<Config>;
      if (c.has("distribution-config")) cfg = c.structured("distribution-config", true) as Partial<Config>;
      else {
        const domain = c.str("origin-domain-name");
        if (!domain) throw new UsageError("the following arguments are required: --distribution-config (or the shortcut --origin-domain-name)");
        cfg = {
          CallerReference: `cli-${now(c.state)}`,
          Origins: { Quantity: 1, Items: [{ Id: domain, DomainName: domain, OriginPath: "", OriginAccessControlId: "" }] },
          DefaultRootObject: c.str("default-root-object") ?? "",
          Enabled: true,
          Comment: "",
        };
      }
      if (cfg.CallerReference && Object.values(c.state.cloudfront.distributions).some((d) => d.callerReference === cfg.CallerReference)) {
        throw c.error("DistributionAlreadyExists", "The caller reference that you are using to create a distribution is associated with another distribution.");
      }
      const id = upperId(c.state);
      const d: Partial<CfDistribution> = {
        id,
        arn: `arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${id}`,
        domain: `d${nextId(c.state, 13).toLowerCase()}.cloudfront.net`,
        createdAt: now(c.state),
        deployedAt: now(c.state) + DEPLOY_MS,
        etag: "E" + nextId(c.state, 12).toUpperCase(),
        callerReference: cfg.CallerReference ?? `cli-${now(c.state)}`,
        cache: {},
        invalidations: [],
      };
      applyConfig(c, d, cfg);
      c.state.cloudfront.distributions[id] = d as CfDistribution;
      return { Location: `https://cloudfront.amazonaws.com/2020-05-31/distribution/${id}`, ETag: d.etag, Distribution: view(c.state, d as CfDistribution) };
    },
    "get-distribution": (c) => {
      const d = need(c, c.str("id"));
      return { ETag: d.etag, Distribution: view(c.state, d) };
    },
    "get-distribution-config": (c) => {
      const d = need(c, c.str("id"));
      return { ETag: d.etag, DistributionConfig: configOf(d) };
    },
    "update-distribution": (c) => {
      const d = need(c, c.str("id"));
      c.authorize("cloudfront:UpdateDistribution", d.arn);
      const match = c.str("if-match");
      if (!match) throw c.error("InvalidIfMatchVersion", "The If-Match version is missing or not valid for the resource.");
      if (match !== d.etag) throw c.error("PreconditionFailed", "The precondition given in one or more of the request header fields evaluated to false.");
      const cfg = c.structured("distribution-config", true) as Partial<Config> & { ETag?: unknown; DistributionConfig?: unknown };
      if (cfg.DistributionConfig) throw new UsageError("Parameter validation failed:\nUnknown parameter in DistributionConfig: \"DistributionConfig\". Save only the DistributionConfig part: --query DistributionConfig");
      applyConfig(c, d, cfg);
      d.etag = "E" + nextId(c.state, 12).toUpperCase();
      // Changes roll out again, but the old configuration keeps serving meanwhile.
      d.deployedAt = now(c.state) + DEPLOY_MS;
      return { ETag: d.etag, Distribution: view(c.state, d) };
    },
    "list-distributions": (c) => {
      const items = Object.values(c.state.cloudfront.distributions).map((d) => {
        const v = view(c.state, d);
        return { Id: v.Id, ARN: v.ARN, Status: v.Status, DomainName: v.DomainName, Enabled: d.enabled, Origins: v.DistributionConfig.Origins, DefaultRootObject: d.defaultRootObject };
      });
      return { DistributionList: { Quantity: items.length, Items: items } };
    },
    "create-invalidation": (c) => {
      const d = need(c, c.str("distribution-id"));
      c.authorize("cloudfront:CreateInvalidation", d.arn);
      let paths = c.list("paths");
      if (!paths.length) {
        const batch = c.structured("invalidation-batch") as { Paths?: { Items?: string[] } } | undefined;
        paths = batch?.Paths?.Items ?? [];
      }
      if (!paths.length) throw new UsageError("the following arguments are required: --paths (for example --paths \"/*\")");
      for (const p of paths) if (!p.startsWith("/")) throw c.error("InvalidArgument", `Your request contains one or more invalid invalidation paths: ${p} (paths start with /)`);
      for (const key of Object.keys(d.cache)) if (paths.some((p) => wildcard(p, key))) delete d.cache[key];
      const inv = { id: "I" + nextId(c.state, 12).toUpperCase(), paths, at: now(c.state) };
      d.invalidations.push(inv);
      return {
        Location: `https://cloudfront.amazonaws.com/2020-05-31/distribution/${d.id}/invalidation/${inv.id}`,
        Invalidation: { Id: inv.id, Status: "InProgress", CreateTime: iso(inv.at), InvalidationBatch: { Paths: { Quantity: paths.length, Items: paths }, CallerReference: `cli-${inv.at}` } },
      };
    },
    "list-invalidations": (c) => {
      const d = need(c, c.str("distribution-id"));
      const items = d.invalidations.map((i) => ({ Id: i.id, CreateTime: iso(i.at), Status: "Completed" }));
      return { InvalidationList: { Quantity: items.length, Items: items } };
    },
    wait: (c) => {
      const what = c.positionals[0];
      if (what === "distribution-deployed") {
        const d = need(c, c.str("id"));
        if (now(c.state) < d.deployedAt) c.state.clockOffset += d.deployedAt - now(c.state);
        return text("");
      }
      if (what === "invalidation-completed") return text("");
      throw new UsageError("aws cloudfront wait: choose distribution-deployed or invalidation-completed");
    },
    "delete-distribution": (c) => {
      const d = need(c, c.str("id"));
      if (d.enabled) throw c.error("DistributionNotDisabled", "The distribution you are trying to delete has not been disabled.");
      delete c.state.cloudfront.distributions[d.id];
    },
  },
};

export const CLOUDFRONT_SERVICES = { cloudfront };
