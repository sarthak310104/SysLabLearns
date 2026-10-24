import { HOME, type AwsState } from "./state";

/*
 * Ready-made broken accounts for the debugging lab. Each is a list of
 * ordinary commands (so everything is built the way you'd build it), plus a
 * few touches no command can make, like a week of failed runs.
 */

export interface Mystery {
  files: Record<string, string>;
  commands: string[];
  after(s: AwsState): void;
  /** What the "users" are complaining about. */
  report: string;
}

const LAMBDA_TRUST = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}`;

export const MYSTERIES: Record<string, Mystery> = {
  "broken-shop": {
    files: {
      [`${HOME}/shop/index.html`]: "<h1>Acme Mugs</h1>\n<p>Fresh mugs, every day.</p>\n",
      [`${HOME}/shop/save-order.mjs`]: `import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Saves each order that arrives on the orders queue.
export const handler = async (event) => {
  for (const record of event.Records ?? []) {
    const order = JSON.parse(record.body);
    await db.send(new PutCommand({ TableName: "Orders", Item: order }));
    console.log("saved order", order.id);
  }
};
`,
      [`${HOME}/shop/cleanup.mjs`]: `// Runs every night to clear out abandoned carts.
export const handler = async (event) => {
  console.log("nightly cleanup ran at", event.time);
  return { cleaned: 3 };
};
`,
      [`${HOME}/shop/trust.json`]: LAMBDA_TRUST,
    },
    commands: [
      "cd ~/shop",
      // 1. The website: public, but the policy names the bucket instead of the objects in it.
      "aws s3 mb s3://acme-shop-site",
      "aws s3 cp index.html s3://acme-shop-site/",
      "aws s3 website s3://acme-shop-site --index-document index.html",
      "aws s3api delete-public-access-block --bucket acme-shop-site",
      `aws s3api put-bucket-policy --bucket acme-shop-site --policy '{"Version":"2012-10-17","Statement":[{"Sid":"PublicRead","Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::acme-shop-site"}]}'`,
      // 2. Orders: the role's policy names the wrong table.
      "aws dynamodb create-table --table-name Orders --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST",
      "aws iam create-role --role-name save-order-role --assume-role-policy-document file://trust.json",
      "aws iam attach-role-policy --role-name save-order-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole",
      `aws iam put-role-policy --role-name save-order-role --policy-name write-orders --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"dynamodb:PutItem","Resource":"arn:aws:dynamodb:ap-south-1:123456789012:table/Order"}]}'`,
      "zip save-order.zip save-order.mjs",
      "aws lambda create-function --function-name save-order --runtime nodejs20.x --handler save-order.handler --role arn:aws:iam::123456789012:role/save-order-role --zip-file fileb://save-order.zip",
      // 3. The queue feeding it: the trigger was switched off during a deploy and never switched back on.
      "aws sqs create-queue --queue-name orders",
      "ESM=$(aws lambda create-event-source-mapping --function-name save-order --event-source-arn arn:aws:sqs:ap-south-1:123456789012:orders --batch-size 10 --query UUID --output text)",
      "aws lambda update-event-source-mapping --uuid $ESM --no-enabled",
      "unset ESM",
      `aws sqs send-message --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/orders --message-body '{"id":"o-1001","item":"mug","total":499}'`,
      `aws sqs send-message --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/orders --message-body '{"id":"o-1002","item":"teapot","total":1299}'`,
      `aws sqs send-message --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/orders --message-body '{"id":"o-1003","item":"mug","total":499}'`,
      // 4. The nightly job: scheduled, but EventBridge was never allowed to call the function.
      "aws iam create-role --role-name cleanup-role --assume-role-policy-document file://trust.json",
      "aws iam attach-role-policy --role-name cleanup-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      "zip cleanup.zip cleanup.mjs",
      "aws lambda create-function --function-name nightly-cleanup --runtime nodejs20.x --handler cleanup.handler --role arn:aws:iam::123456789012:role/cleanup-role --zip-file fileb://cleanup.zip",
      `aws events put-rule --name nightly-cleanup --schedule-expression "cron(30 20 * * ? *)"`,
      "aws events put-targets --rule nightly-cleanup --targets Id=cleanup,Arn=arn:aws:lambda:ap-south-1:123456789012:function:nightly-cleanup",
      "cd ~",
    ],
    after(s) {
      // Functions are ready at once (no waiting around in a mystery).
      for (const f of Object.values(s.lambda.functions)) f.activeAt = Math.min(f.activeAt, Date.now() + s.clockOffset);
      for (const t of Object.values(s.dynamodb.tables)) t.activeAt = Math.min(t.activeAt, Date.now() + s.clockOffset);
      const r = s.events.rules["nightly-cleanup"];
      if (r) r.stats = { triggered: 7, invocations: 0, failed: 7 };
    },
    report: `Acme Mugs' account is set up, and it's broken in four places. Here's what people are telling you:

  1. Customers: "The shop website just says 403 Forbidden."
     http://acme-shop-site.s3-website.ap-south-1.amazonaws.com
  2. The orders team: "Three orders were placed this morning, and none of them are in the Orders table."
  3. Same team: "Even when we test the save-order function by hand, it errors."
  4. Ops: "The nightly-cleanup job hasn't run all week. Nothing in its logs at all."

Find each cause with the CLI, fix it, and check the fix. The lesson has hints if you get stuck.
`,
  },
};
