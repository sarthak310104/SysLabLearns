import { decide, trusts } from "@/engine/aws/iam-eval";
import { HOME, type AwsState } from "@/engine/aws/state";
import { cloudfrontCanRead, publicCanRead } from "@/engine/aws/s3";

/** One command you ran, kept so steps can check what you tried. */
export interface HistoryEntry {
  line: string;
  code: number;
  out: string;
  err: string;
  t: number;
}

export interface AwsStep {
  id: string;
  /** What to do, in plain words. Shown in the goal list. */
  text: string;
  hint?: string;
  /** A ladder of hints instead of one: a nudge, a direction, then nearly the answer. */
  hints?: string[];
  done(s: AwsState, h: HistoryEntry[]): boolean;
}

export interface AwsLabDef {
  slug: string;
  steps: AwsStep[];
}

/* ---------------- helpers for checks ---------------- */

/** Did you run a command matching this pattern, and did it succeed? */
const ran = (h: HistoryEntry[], re: RegExp, ok = true) => h.some((e) => re.test(e.line) && (!ok || e.code === 0));
const ranAndSaw = (h: HistoryEntry[], re: RegExp, out: RegExp) => h.some((e) => re.test(e.line) && out.test(e.out + e.err));
const buckets = (s: AwsState) => Object.values(s.s3.buckets);
const queues = (s: AwsState) => Object.values(s.sqs.queues);
const tables = (s: AwsState) => Object.values(s.dynamodb.tables);
const fns = (s: AwsState) => Object.values(s.lambda.functions);
const user = (name: string) => ({ kind: "user" as const, name, arn: `arn:aws:iam::123456789012:user/${name}` });
const role = (name: string) => ({ kind: "role" as const, name, arn: `arn:aws:iam::123456789012:role/${name}` });

export const AWS_LABS: AwsLabDef[] = [
  {
    slug: "c1-cloud-basics",
    steps: [
      {
        id: "whoami",
        text: "Ask AWS who you are: run aws sts get-caller-identity.",
        hint: "Click the command in the lesson to put it in the terminal, then press Enter.",
        done: (_s, h) => ran(h, /aws\s+sts\s+get-caller-identity/),
      },
      {
        id: "look",
        text: "Look around: list your home folder with ls and print hello.txt with cat.",
        done: (_s, h) => ran(h, /^\s*ls\b/) && ran(h, /^\s*cat\s+.*hello\.txt/),
      },
      {
        id: "file",
        text: "Make a new file with echo and > (for example notes.txt).",
        hint: 'echo "my first file" > notes.txt',
        done: (s) => Object.keys(s.files).some((f) => f.startsWith(HOME + "/") && !f.endsWith("hello.txt") && !f.endsWith("/.keep") && s.files[f].trim().length > 0),
      },
      {
        id: "query",
        text: "Pick out just your account number with --query Account --output text.",
        done: (_s, h) => ran(h, /aws\s.*--query\s+\S*Account/),
      },
      {
        id: "variable",
        text: "Save that answer in a variable with $(...) and print it with echo.",
        hint: "ACCOUNT=$(aws sts get-caller-identity --query Account --output text) then echo $ACCOUNT",
        done: (_s, h) => ran(h, /^\s*[A-Za-z_]\w*=\$\(\s*aws\s/) && ran(h, /^\s*echo\s+.*\$\{?[A-Za-z_]/),
      },
    ],
  },
  {
    slug: "c2-s3",
    steps: [
      {
        id: "bucket",
        text: "Create a bucket with a name nobody else has (put your name in it).",
        hint: "aws s3 mb s3://yourname-notes-2026",
        done: (s) => buckets(s).length > 0,
      },
      {
        id: "upload",
        text: "Upload hello.txt into your bucket.",
        done: (s) => buckets(s).some((b) => Object.keys(b.objects).some((k) => k.endsWith("hello.txt"))),
      },
      {
        id: "folders",
        text: "Put a file under a folder-like prefix, such as photos/cat.txt, and list the bucket.",
        done: (s, h) => buckets(s).some((b) => Object.keys(b.objects).some((k) => k.includes("/"))) && ranAndSaw(h, /aws\s+s3\s+ls\s+s3:\/\//, /PRE /),
      },
      {
        id: "download",
        text: "Download an object back to your home folder with aws s3 cp s3://... ./",
        done: (_s, h) => ran(h, /aws\s+s3\s+cp\s+s3:\/\/\S+\s+(?!s3:\/\/)\S+/),
      },
      {
        id: "private",
        text: "Try to open the object with curl and see Access Denied: buckets are private.",
        done: (_s, h) => ranAndSaw(h, /^\s*curl\s+\S*amazonaws\.com/, /AccessDenied/),
      },
      {
        id: "presign",
        text: "Share it safely: make a presigned URL and fetch it with curl.",
        hint: 'URL=$(aws s3 presign s3://yourname-notes-2026/hello.txt --expires-in 300) then curl "$URL"',
        done: (_s, h) => h.some((e) => /^\s*curl\b/.test(e.line) && e.code === 0 && !/<Error>/.test(e.out) && /X-Amz-Signature|\$\w+/.test(e.line) && e.out.length > 0),
      },
      {
        id: "versions",
        text: "Turn on versioning, overwrite a file, and see both versions listed.",
        done: (s, h) => buckets(s).some((b) => b.versioning === "Enabled" && Object.values(b.versions ?? {}).some((v) => v.length > 0)) && ran(h, /list-object-versions/),
      },
    ],
  },
  {
    slug: "c3-iam",
    steps: [
      {
        id: "user",
        text: "Create a user called intern.",
        done: (s) => Boolean(s.iam.users.intern),
      },
      {
        id: "profile",
        text: "Give intern an access key and save it as a CLI profile called intern.",
        hint: "aws iam create-access-key --user-name intern, then aws configure set aws_access_key_id <the AccessKeyId> --profile intern",
        done: (s) => Object.entries(s.profiles).some(([p, v]) => p !== "default" && v.user === "intern"),
      },
      {
        id: "denied",
        text: "Run aws s3 ls --profile intern and read the Access Denied message.",
        done: (_s, h) => ranAndSaw(h, /--profile\s+intern/, /AccessDenied|not authorized/),
      },
      {
        id: "readonly",
        text: "Attach AmazonS3ReadOnlyAccess to intern and list buckets as intern.",
        done: (s, h) => (s.iam.users.intern?.attached ?? []).some((a) => a.endsWith("/AmazonS3ReadOnlyAccess")) && ran(h, /aws\s+s3\s+ls.*--profile\s+intern|--profile\s+intern.*aws\s+s3\s+ls/),
      },
      {
        id: "least",
        text: "Least privilege: replace the broad policy with your own that only allows reading one bucket.",
        hint: "Detach AmazonS3ReadOnlyAccess, then put-user-policy with s3:ListBucket on arn:aws:s3:::BUCKET and s3:GetObject on arn:aws:s3:::BUCKET/*",
        done: (s) => {
          const u = s.iam.users.intern;
          if (!u) return false;
          if (u.attached.some((a) => /AmazonS3(ReadOnly|Full)Access|AdministratorAccess|ReadOnlyAccess$/.test(a))) return false;
          const p = user("intern");
          const okBucket = buckets(s).some((b) => decide(s, p, "s3:GetObject", `arn:aws:s3:::${b.name}/hello.txt`) === "allow" && decide(s, p, "s3:ListBucket", `arn:aws:s3:::${b.name}`) === "allow");
          const tooWide = decide(s, p, "s3:GetObject", "arn:aws:s3:::someone-elses-bucket/x") === "allow" || buckets(s).some((b) => decide(s, p, "s3:DeleteObject", `arn:aws:s3:::${b.name}/x`) === "allow");
          return okBucket && !tooWide;
        },
      },
      {
        id: "simulate",
        text: "Check your work without trying it for real: aws iam simulate-principal-policy.",
        done: (_s, h) => ran(h, /simulate-principal-policy/),
      },
    ],
  },
  {
    slug: "c4-sqs",
    steps: [
      { id: "queue", text: "Create a queue called orders and save its URL in a variable.", done: (s, h) => queues(s).length > 0 && ran(h, /^\s*[A-Za-z_]\w*=\$\(\s*aws\s+sqs\s+(create-queue|get-queue-url)/) },
      { id: "send", text: "Send three messages to it.", done: (_s, h) => h.filter((e) => /aws\s+sqs\s+send-message/.test(e.line) && e.code === 0).length >= 3 },
      {
        id: "work",
        text: "Act as a worker: receive a message, then delete it with its receipt handle.",
        done: (_s, h) => ran(h, /aws\s+sqs\s+delete-message/),
      },
      {
        id: "visibility",
        text: "Receive a message without deleting it, wait past the visibility timeout (sleep 31), and receive it again.",
        done: (s) => queues(s).some((q) => (q.stats?.redelivered ?? 0) > 0),
      },
      {
        id: "dlq",
        text: "Make a dead-letter queue and attach it with a RedrivePolicy (maxReceiveCount 2).",
        done: (s) => queues(s).some((q) => Boolean(q.attributes.RedrivePolicy)),
      },
      {
        id: "poison",
        text: "Send a message nobody can process and watch it land in the dead-letter queue.",
        done: (s) => queues(s).some((q) => (q.stats?.deadLettered ?? 0) > 0),
      },
    ],
  },
  {
    slug: "c5-sns",
    steps: [
      { id: "topic", text: "Create a topic called order-placed.", done: (s) => Object.keys(s.sns.topics).length > 0 },
      {
        id: "subscribe",
        text: "Subscribe two queues to it (for example email-jobs and stock-jobs).",
        done: (s) => Object.values(s.sns.topics).some((t) => t.subscriptions.filter((x) => x.protocol === "sqs").length >= 2),
      },
      { id: "publish", text: "Publish one message to the topic.", done: (_s, h) => ran(h, /aws\s+sns\s+publish/) },
      {
        id: "fanout",
        text: "Receive it from both queues: one publish, two copies.",
        done: (s) => queues(s).filter((q) => (q.stats?.fromSns ?? 0) > 0).length >= 2,
      },
      {
        id: "filter",
        text: "Give one subscription a filter policy, and publish a message with attributes that only it should get.",
        done: (s, h) => Object.values(s.sns.topics).some((t) => t.subscriptions.some((x) => x.filterPolicy)) && ran(h, /aws\s+sns\s+publish.*--message-attributes/),
      },
    ],
  },
  {
    slug: "c6-dynamodb",
    steps: [
      {
        id: "table",
        text: "Create a table with a partition key and a sort key, and wait for it to be ACTIVE.",
        done: (s, h) => tables(s).some((t) => t.keySchema.length === 2) && ran(h, /aws\s+dynamodb\s+(wait\s+table-exists|describe-table)/),
      },
      {
        id: "items",
        text: "Put at least three items, for at least two different partition key values.",
        done: (s) =>
          tables(s).some((t) => {
            const hash = t.keySchema.find((k) => k.KeyType === "HASH")!.AttributeName;
            return t.items.length >= 3 && new Set(t.items.map((i) => JSON.stringify(i[hash]))).size >= 2;
          }),
      },
      { id: "query", text: "Query one partition: every item for one partition key value.", done: (_s, h) => ran(h, /aws\s+dynamodb\s+query/) },
      {
        id: "scan",
        text: "Scan with a filter and compare Count with ScannedCount.",
        done: (_s, h) => ran(h, /aws\s+dynamodb\s+scan.*--filter-expression/),
      },
      {
        id: "condition",
        text: "Block an overwrite with a condition expression and see ConditionalCheckFailedException.",
        done: (_s, h) => h.some((e) => /ConditionalCheckFailedException/.test(e.err)),
      },
      {
        id: "counter",
        text: "Count something with update-item and ADD, without reading the item first.",
        done: (_s, h) => ran(h, /aws\s+dynamodb\s+update-item.*ADD/i),
      },
    ],
  },
  {
    slug: "c7-lambda",
    steps: [
      {
        id: "role",
        text: "Create a role Lambda can use (trust lambda.amazonaws.com) with AWSLambdaBasicExecutionRole attached.",
        done: (s) =>
          Object.values(s.iam.roles).some((r) => trusts(r.trust, "lambda.amazonaws.com") && r.attached.some((a) => a.endsWith("/AWSLambdaBasicExecutionRole") || a.endsWith("/AWSLambdaSQSQueueExecutionRole"))),
      },
      {
        id: "zip",
        text: "Write index.mjs with a handler and zip it into function.zip.",
        done: (s) => Object.entries(s.files).some(([f, c]) => f.endsWith(".zip") && /\.mjs"/.test(c)),
      },
      { id: "create", text: "Create the function.", done: (s) => fns(s).length > 0 },
      {
        id: "invoke",
        text: "Invoke it with a JSON payload and read out.json.",
        done: (_s, h) => h.some((e) => /aws\s+lambda\s+invoke/.test(e.line) && e.code === 0 && !/FunctionError/.test(e.out)) && ran(h, /^\s*cat\s+\S*\.json/),
      },
      { id: "logs", text: "Read its logs with aws logs tail.", done: (_s, h) => ranAndSaw(h, /aws\s+logs\s+tail/, /START RequestId/) },
      { id: "env", text: "Change its behaviour without new code: set an environment variable.", done: (s) => fns(s).some((f) => Object.keys(f.env).length > 0) },
      {
        id: "trigger",
        text: "Connect a queue to it with an event source mapping, send a message, and see the function run.",
        done: (s) => fns(s).some((f) => (f.stats?.bySource.sqs ?? 0) > 0),
      },
    ],
  },
  {
    slug: "c8-serverless-api",
    steps: [
      {
        id: "table",
        text: "Create a Notes table with id as its partition key.",
        done: (s) => tables(s).some((t) => t.keySchema.length >= 1),
      },
      {
        id: "function",
        text: "Deploy a function that uses the AWS SDK to save and list notes.",
        done: (s) => fns(s).some((f) => Object.values(f.code).some((c) => c.includes("@aws-sdk/"))),
      },
      { id: "api", text: "Create an HTTP API that sends requests to the function.", done: (s) => Object.values(s.apigw.apis).some((a) => Object.keys(a.routes).length > 0) },
      {
        id: "permission",
        text: "Allow API Gateway to invoke the function (aws lambda add-permission).",
        done: (s) => fns(s).some((f) => f.permissions.some((p) => p.principal === "apigateway.amazonaws.com")),
      },
      {
        id: "works",
        text: "Save a note with curl -X POST, then list notes with curl.",
        done: (s, h) =>
          h.some((e) => /^\s*curl\b.*(-X\s+POST|-d\s)/.test(e.line) && /saved|201|"id"/.test(e.out) && !/Internal Server Error/.test(e.out)) &&
          h.some((e) => /^\s*curl\b/.test(e.line) && !/-X\s+POST|-d\s/.test(e.line) && /^\s*\[/.test(e.out)) &&
          tables(s).some((t) => t.items.length > 0),
      },
      {
        id: "least",
        text: "Least privilege: the function's role can read and write its table, and nothing else in DynamoDB.",
        done: (s) =>
          fns(s).some((f) => {
            if (!Object.values(f.code).some((c) => c.includes("@aws-sdk/"))) return false;
            const name = f.role.split("/").pop()!;
            const r = s.iam.roles[name];
            if (!r || r.attached.some((a) => /DynamoDBFullAccess|AdministratorAccess/.test(a))) return false;
            const p = role(name);
            return tables(s).some(
              (t) =>
                decide(s, p, "dynamodb:PutItem", t.arn) === "allow" &&
                decide(s, p, "dynamodb:DeleteTable", t.arn) !== "allow" &&
                decide(s, p, "dynamodb:PutItem", "arn:aws:dynamodb:ap-south-1:123456789012:table/SomeOtherTable") !== "allow",
            );
          }),
      },
    ],
  },
];

const dists = (s: AwsState) => Object.values(s.cloudfront?.distributions ?? {});
const rules = (s: AwsState) => Object.values(s.events?.rules ?? {});
const machines = (s: AwsState) => Object.values(s.sfn?.machines ?? {});
const execs = (s: AwsState) => s.sfn?.executions ?? [];
const allBlocked = (b: AwsState["s3"]["buckets"][string]) => Object.values(b.publicAccessBlock).every(Boolean);

AWS_LABS.push(
  {
    slug: "c9-websites",
    steps: [
      {
        id: "website",
        text: "Turn on static website hosting for a bucket, with an index document.",
        hint: "aws s3 website s3://yourname-site-2026 --index-document index.html --error-document error.html",
        done: (s) => buckets(s).some((b) => Boolean(b.website?.index) && Boolean(b.objects[b.website!.index])),
      },
      {
        id: "public",
        text: "Make the website endpoint answer with your page (it needs a public read policy).",
        hint: "Switch off the public access block, then add a bucket policy with Principal * allowing s3:GetObject on arn:aws:s3:::BUCKET/*.",
        done: (_s, h) => h.some((e) => /^\s*curl\b.*s3-website/.test(e.line) && e.code === 0 && /<h1>/.test(e.out) && !/403 Forbidden|404 Not Found/.test(e.out)),
      },
      {
        id: "cdn",
        text: "Serve the site through a CloudFront distribution, and see a cache Hit.",
        hint: "Create the distribution, wait for it to deploy, then curl -i https://$CF twice and look at x-cache.",
        done: (s, h) => dists(s).length > 0 && ranAndSaw(h, /^\s*curl\b.*cloudfront\.net|^\s*curl\b.*\$CF/, /Hit from cloudfront/),
      },
      {
        id: "private",
        text: "Lock it down: the bucket is private again, and CloudFront still reads it through an origin access control.",
        hint: "Attach an OAC to the distribution, change the bucket policy to allow only cloudfront.amazonaws.com for your distribution, and switch the public access block back on.",
        done: (s) =>
          dists(s).some((d) => {
            const b = s.s3.buckets[d.origin.domain.split(".s3")[0]];
            const key = d.defaultRootObject || "index.html";
            return Boolean(d.origin.oacId && b && allBlocked(b) && !publicCanRead(b, key) && cloudfrontCanRead(b, key, d.arn));
          }),
      },
      {
        id: "invalidate",
        text: "Upload a change, then invalidate the cache so CloudFront serves the new version.",
        done: (s, h) => dists(s).some((d) => d.invalidations.length > 0) && h.some((e, i) => /create-invalidation/.test(e.line) && e.code === 0 && h.slice(i + 1).some((x) => /^\s*curl\b/.test(x.line) && /Miss from cloudfront/.test(x.out))),
      },
    ],
  },
  {
    slug: "c10-eventbridge",
    steps: [
      {
        id: "schedule",
        text: "Create a scheduled rule that targets your function.",
        done: (s) => rules(s).some((r) => Boolean(r.schedule) && r.targets.some((t) => t.Arn.startsWith("arn:aws:lambda:"))),
      },
      {
        id: "diagnose",
        text: "When nothing runs, find the FailedInvocations count in CloudWatch.",
        done: (_s, h) => ranAndSaw(h, /aws\s+cloudwatch\s+get-metric-statistics.*FailedInvocations/, /"Sum":\s*[1-9]/),
      },
      {
        id: "runs",
        text: "Let EventBridge invoke the function, and see the scheduled runs in its logs.",
        hint: "aws lambda add-permission with --principal events.amazonaws.com and --source-arn set to the rule's ARN, then sleep and tail the logs.",
        done: (s) => rules(s).some((r) => Boolean(r.schedule) && r.stats.invocations > 0) && fns(s).some((f) => (f.stats?.bySource.events ?? 0) > 0),
      },
      {
        id: "cron",
        text: "Write a cron schedule for weekdays at 9:00 India time (remember: cron is UTC).",
        hint: "9:00 IST is 03:30 UTC: cron(30 3 ? * MON-FRI *)",
        done: (s) => rules(s).some((r) => /^cron\(30 3 \? \* (MON-FRI|2-6) \*\)$/.test(r.schedule ?? "")),
      },
      {
        id: "pattern",
        text: "Route only big orders to a queue with an event pattern, and send events to test it.",
        done: (s) => rules(s).some((r) => Boolean(r.pattern) && r.stats.triggered > 0) && queues(s).some((q) => q.messages.some((m) => /"detail-type":"OrderPlaced"/.test(m.body))),
      },
    ],
  },
  {
    slug: "c11-step-functions",
    steps: [
      { id: "machine", text: "Create the order-flow state machine with its own role.", done: (s) => machines(s).length > 0 },
      {
        id: "permission",
        text: "Read why the first run failed, and give the state machine's role just enough permission.",
        hint: "describe-execution shows error and cause. The role needs lambda:InvokeFunction on the order functions.",
        done: (s) => execs(s).some((e) => e.error === "Lambda.AWSLambdaException") && execs(s).some((e) => e.status === "SUCCEEDED"),
      },
      {
        id: "wait",
        text: "Watch an execution go from RUNNING to SUCCEEDED after its Wait state.",
        done: (_s, h) => ranAndSaw(h, /describe-execution/, /RUNNING/) && ranAndSaw(h, /describe-execution/, /SUCCEEDED/),
      },
      {
        id: "paths",
        text: "Send orders down the other two paths: a declined card and an out-of-stock item.",
        done: (s) => execs(s).some((e) => e.error === "PaymentFailed") && execs(s).some((e) => e.error === "OutOfStock"),
      },
      {
        id: "history",
        text: "Read an execution's history to see each step it took.",
        done: (_s, h) => ranAndSaw(h, /get-execution-history/, /TaskStateEntered/),
      },
    ],
  },
  {
    slug: "c12-mystery",
    steps: [
      { id: "setup", text: "Set up the broken shop with lab-setup broken-shop.", done: (s) => Boolean(s.s3.buckets["acme-shop-site"]) },
      {
        id: "site",
        text: "Customers can load the shop's website again.",
        hints: [
          "The website answers 403. Who is allowed to read the objects in that bucket?",
          "Read the bucket policy carefully. Which resource does it allow s3:GetObject on: the bucket, or the objects inside it?",
          "Put the same policy back with Resource arn:aws:s3:::acme-shop-site/* (note the /*).",
        ],
        done: (s) => {
          const b = s.s3.buckets["acme-shop-site"];
          return Boolean(b?.website && publicCanRead(b, b.website.index));
        },
      },
      {
        id: "role",
        text: "The save-order function can write to the Orders table.",
        hints: [
          "Invoke save-order yourself and read the error. Which action, on which resource, was denied?",
          "List the role's inline policies and read write-orders. Compare its Resource with the table's real ARN, letter by letter.",
          "put-role-policy again with Resource arn:aws:dynamodb:ap-south-1:123456789012:table/Orders.",
        ],
        done: (s) => decide(s, role("save-order-role"), "dynamodb:PutItem", "arn:aws:dynamodb:ap-south-1:123456789012:table/Orders") === "allow",
      },
      {
        id: "queue",
        text: "This morning's three orders make it from the queue into the Orders table.",
        hints: [
          "The orders queue still has messages in it. What is supposed to take them out?",
          "list-event-source-mappings shows the trigger from the queue to save-order. What state is it in?",
          "Enable it with aws lambda update-event-source-mapping --uuid UUID --enabled (after fixing the role, or the orders will fail again).",
        ],
        done: (s) => {
          const t = s.dynamodb.tables["Orders"];
          const ids = new Set((t?.items ?? []).map((i) => (i.id as { S?: string })?.S));
          return ["o-1001", "o-1002", "o-1003"].every((id) => ids.has(id));
        },
      },
      {
        id: "nightly",
        text: "The nightly-cleanup job runs on schedule again.",
        hints: [
          "No logs at all means the function never started. Did the rule fire? Check FailedInvocations.",
          "The rule fires, but fails to invoke. Who is allowed to invoke nightly-cleanup? (get-policy)",
          "Add a permission for events.amazonaws.com with --source-arn arn:aws:events:ap-south-1:123456789012:rule/nightly-cleanup, then sleep 86400.",
        ],
        done: (s) => (s.events?.rules["nightly-cleanup"]?.stats.invocations ?? 0) > 0,
      },
    ],
  },
);

export const awsLabBySlug = (slug: string) => AWS_LABS.find((l) => l.slug === slug);
