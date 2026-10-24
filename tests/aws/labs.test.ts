import { describe, expect, it } from "vitest";
import { AWS_LABS, type HistoryEntry } from "@/content/aws/labs";
import { AwsLab } from "@/engine/aws/shell";
import { freshState } from "@/engine/aws/state";

const TRUST = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}`;

/** Files a learner saves from the lesson (with "Save as") before running the commands. */
const FILES: Record<string, Record<string, string>> = {
  "c9-websites": { "index.html": "<h1>Hello from my site</h1>\n", "error.html": "<h1>Nothing here</h1>\n" },
  "c10-eventbridge": {
    "report.mjs": 'export const handler = async (event) => {\n  console.log("report for", event.time);\n  return "done";\n};\n',
    "pattern.json": '{"source":["shop.orders"],"detail-type":["OrderPlaced"],"detail":{"total":[{"numeric":[">=",1000]}]}}',
    "orders.json": '[{"Source":"shop.orders","DetailType":"OrderPlaced","Detail":"{\\"id\\":\\"o-1\\",\\"total\\":250}"},{"Source":"shop.orders","DetailType":"OrderPlaced","Detail":"{\\"id\\":\\"o-2\\",\\"total\\":4500}"}]',
  },
  "c11-step-functions": {
    "steps.mjs": 'export const checkStock = async (order) => ({ available: order.item !== "teapot", left: 12 });\nexport const chargeCard = async (order) => {\n  if (order.amount > 5000) {\n    const e = new Error("declined");\n    e.name = "CardDeclined";\n    throw e;\n  }\n  return { charged: order.amount };\n};\n',
    "sfn-trust.json": '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"states.amazonaws.com"},"Action":"sts:AssumeRole"}]}',
    "order-flow.json": "{\"Comment\": \"Place an order\", \"StartAt\": \"CheckStock\", \"States\": {\"CheckStock\": {\"Type\": \"Task\", \"Resource\": \"arn:aws:lambda:ap-south-1:123456789012:function:order-check-stock\", \"ResultPath\": \"$.stock\", \"Next\": \"InStock?\"}, \"InStock?\": {\"Type\": \"Choice\", \"Choices\": [{\"Variable\": \"$.stock.available\", \"BooleanEquals\": true, \"Next\": \"ChargeCard\"}], \"Default\": \"OutOfStock\"}, \"OutOfStock\": {\"Type\": \"Fail\", \"Error\": \"OutOfStock\", \"Cause\": \"Not enough left\"}, \"ChargeCard\": {\"Type\": \"Task\", \"Resource\": \"arn:aws:lambda:ap-south-1:123456789012:function:order-charge-card\", \"ResultPath\": \"$.payment\", \"Retry\": [{\"ErrorEquals\": [\"PaymentServiceBusy\"], \"IntervalSeconds\": 2, \"MaxAttempts\": 3, \"BackoffRate\": 2}], \"Catch\": [{\"ErrorEquals\": [\"CardDeclined\"], \"ResultPath\": \"$.error\", \"Next\": \"PaymentFailed\"}], \"Next\": \"WaitForPacking\"}, \"PaymentFailed\": {\"Type\": \"Fail\", \"Error\": \"PaymentFailed\", \"Cause\": \"The card was declined\"}, \"WaitForPacking\": {\"Type\": \"Wait\", \"Seconds\": 60, \"Next\": \"Done\"}, \"Done\": {\"Type\": \"Succeed\"}}}",
  },
};

/** What a learner types for each lab, in order. */
const SCRIPTS: Record<string, string[]> = {
  "c1-cloud-basics": [
    "aws sts get-caller-identity",
    "ls",
    "cat hello.txt",
    'echo "my first file" > notes.txt',
    "aws sts get-caller-identity --query Account --output text",
    "ACCOUNT=$(aws sts get-caller-identity --query Account --output text)",
    "echo $ACCOUNT",
  ],
  "c2-s3": [
    "aws s3 mb s3://asha-notes-2026",
    "aws s3 cp hello.txt s3://asha-notes-2026/",
    'echo "meow" > cat.txt',
    "aws s3 cp cat.txt s3://asha-notes-2026/photos/cat.txt",
    "aws s3 ls s3://asha-notes-2026",
    "aws s3 cp s3://asha-notes-2026/photos/cat.txt ./downloaded-cat.txt",
    "curl https://asha-notes-2026.s3.ap-south-1.amazonaws.com/hello.txt",
    "URL=$(aws s3 presign s3://asha-notes-2026/hello.txt --expires-in 300)",
    'curl "$URL"',
    "aws s3api put-bucket-versioning --bucket asha-notes-2026 --versioning-configuration Status=Enabled",
    'echo "version two" > hello.txt',
    "aws s3 cp hello.txt s3://asha-notes-2026/hello.txt",
    "aws s3api list-object-versions --bucket asha-notes-2026",
  ],
  "c3-iam": [
    "aws s3 mb s3://asha-team-docs",
    "aws s3 cp hello.txt s3://asha-team-docs/",
    "aws iam create-user --user-name intern",
    "KEY=$(aws iam create-access-key --user-name intern --query AccessKey.AccessKeyId --output text)",
    "aws configure set aws_access_key_id $KEY --profile intern",
    "aws s3 ls --profile intern",
    "aws iam attach-user-policy --user-name intern --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
    "aws s3 ls --profile intern",
    "aws iam detach-user-policy --user-name intern --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
    `aws iam put-user-policy --user-name intern --policy-name read-team-docs --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::asha-team-docs"},{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::asha-team-docs/*"}]}'`,
    "aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::123456789012:user/intern --action-names s3:GetObject s3:DeleteObject --resource-arns arn:aws:s3:::asha-team-docs/hello.txt",
  ],
  "c4-sqs": [
    "Q=$(aws sqs create-queue --queue-name orders --query QueueUrl --output text)",
    'aws sqs send-message --queue-url $Q --message-body "order 1"',
    'aws sqs send-message --queue-url $Q --message-body "order 2"',
    'aws sqs send-message --queue-url $Q --message-body "order 3"',
    "H=$(aws sqs receive-message --queue-url $Q --query 'Messages[0].ReceiptHandle' --output text)",
    "aws sqs delete-message --queue-url $Q --receipt-handle $H",
    "aws sqs receive-message --queue-url $Q",
    "sleep 31",
    "aws sqs receive-message --queue-url $Q --max-number-of-messages 10",
    "aws sqs create-queue --queue-name orders-dlq",
    "DLQ=$(aws sqs get-queue-attributes --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/orders-dlq --attribute-names QueueArn --query Attributes.QueueArn --output text)",
    `aws sqs set-queue-attributes --queue-url $Q --attributes '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"arn:aws:sqs:ap-south-1:123456789012:orders-dlq\\",\\"maxReceiveCount\\":\\"2\\"}","VisibilityTimeout":"5"}'`,
    "aws sqs purge-queue --queue-url $Q",
    'aws sqs send-message --queue-url $Q --message-body "broken order"',
    "aws sqs receive-message --queue-url $Q",
    "sleep 6",
    "aws sqs receive-message --queue-url $Q",
    "sleep 6",
    "aws sqs receive-message --queue-url $Q",
  ],
  "c5-sns": [
    "T=$(aws sns create-topic --name order-placed --query TopicArn --output text)",
    "aws sqs create-queue --queue-name email-jobs",
    "aws sqs create-queue --queue-name stock-jobs",
    "aws sns subscribe --topic-arn $T --protocol sqs --notification-endpoint arn:aws:sqs:ap-south-1:123456789012:email-jobs",
    "aws sns subscribe --topic-arn $T --protocol sqs --notification-endpoint arn:aws:sqs:ap-south-1:123456789012:stock-jobs",
    `aws sns publish --topic-arn $T --message '{"order":42}'`,
    "aws sqs receive-message --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/email-jobs",
    "SUB=$(aws sns list-subscriptions-by-topic --topic-arn $T --query \"Subscriptions[?contains(Endpoint, 'stock')].SubscriptionArn | [0]\" --output text)",
    `aws sns set-subscription-attributes --subscription-arn $SUB --attribute-name FilterPolicy --attribute-value '{"kind":["big"]}'`,
    `aws sns publish --topic-arn $T --message "small order" --message-attributes '{"kind":{"DataType":"String","StringValue":"small"}}'`,
  ],
  "c6-dynamodb": [
    "aws dynamodb create-table --table-name Orders --attribute-definitions AttributeName=customer,AttributeType=S AttributeName=orderId,AttributeType=S --key-schema AttributeName=customer,KeyType=HASH AttributeName=orderId,KeyType=RANGE --billing-mode PAY_PER_REQUEST",
    "aws dynamodb wait table-exists --table-name Orders",
    `aws dynamodb put-item --table-name Orders --item '{"customer":{"S":"asha"},"orderId":{"S":"2026-10-01"},"amount":{"N":"250"}}'`,
    `aws dynamodb put-item --table-name Orders --item '{"customer":{"S":"asha"},"orderId":{"S":"2026-10-12"},"amount":{"N":"900"}}'`,
    `aws dynamodb put-item --table-name Orders --item '{"customer":{"S":"ravi"},"orderId":{"S":"2026-10-03"},"amount":{"N":"120"}}'`,
    `aws dynamodb query --table-name Orders --key-condition-expression "customer = :c" --expression-attribute-values '{":c":{"S":"asha"}}'`,
    `aws dynamodb scan --table-name Orders --filter-expression "amount > :a" --expression-attribute-values '{":a":{"N":"200"}}'`,
    `aws dynamodb put-item --table-name Orders --item '{"customer":{"S":"asha"},"orderId":{"S":"2026-10-01"}}' --condition-expression "attribute_not_exists(orderId)"`,
    `aws dynamodb update-item --table-name Orders --key '{"customer":{"S":"asha"},"orderId":{"S":"2026-10-01"}}' --update-expression "ADD views :one" --expression-attribute-values '{":one":{"N":"1"}}'`,
  ],
  "c7-lambda": [
    `echo '${TRUST}' > trust.json`,
    "aws iam create-role --role-name hello-role --assume-role-policy-document file://trust.json",
    "aws iam attach-role-policy --role-name hello-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    `printf '%s' 'export const handler = async (event) => { console.log("event", event); return { message: (process.env.GREETING ?? "Hello") + ", " + (event.name ?? "world") }; };' > index.mjs`,
    "zip function.zip index.mjs",
    "aws lambda create-function --function-name hello --runtime nodejs20.x --handler index.handler --role arn:aws:iam::123456789012:role/hello-role --zip-file fileb://function.zip",
    "aws lambda wait function-active-v2 --function-name hello",
    `aws lambda invoke --function-name hello --cli-binary-format raw-in-base64-out --payload '{"name":"Asha"}' out.json`,
    "cat out.json",
    "aws logs tail /aws/lambda/hello",
    "aws lambda update-function-configuration --function-name hello --environment Variables={GREETING=Namaste}",
    "aws iam attach-role-policy --role-name hello-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole",
    "aws sqs create-queue --queue-name greetings",
    "aws lambda create-event-source-mapping --function-name hello --event-source-arn arn:aws:sqs:ap-south-1:123456789012:greetings",
    'aws sqs send-message --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/greetings --message-body "hi"',
  ],
  "c8-serverless-api": [
    "aws dynamodb create-table --table-name Notes --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST",
    "aws dynamodb wait table-exists --table-name Notes",
    `echo '${TRUST}' > trust.json`,
    "aws iam create-role --role-name notes-role --assume-role-policy-document file://trust.json",
    "aws iam attach-role-policy --role-name notes-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    `aws iam put-role-policy --role-name notes-role --policy-name notes-table --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:PutItem","dynamodb:Scan"],"Resource":"arn:aws:dynamodb:ap-south-1:123456789012:table/Notes"}]}'`,
    `printf '%s' 'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const handler = async (event) => {
  if (event.requestContext.http.method === "POST") {
    const note = JSON.parse(event.body);
    await db.send(new PutCommand({ TableName: "Notes", Item: note }));
    return { statusCode: 201, body: JSON.stringify({ saved: note.id }) };
  }
  const { Items } = await db.send(new ScanCommand({ TableName: "Notes" }));
  return { statusCode: 200, body: JSON.stringify(Items) };
};' > index.mjs`,
    "zip function.zip index.mjs",
    "aws lambda create-function --function-name notes --runtime nodejs20.x --handler index.handler --role arn:aws:iam::123456789012:role/notes-role --zip-file fileb://function.zip",
    "aws lambda wait function-active-v2 --function-name notes",
    "API=$(aws apigatewayv2 create-api --name notes-api --protocol-type HTTP --target arn:aws:lambda:ap-south-1:123456789012:function:notes --query ApiId --output text)",
    `aws lambda add-permission --function-name notes --statement-id apigw --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:ap-south-1:123456789012:$API/*"`,
    `curl -X POST https://$API.execute-api.ap-south-1.amazonaws.com/notes -d '{"id":"n1","text":"buy milk"}'`,
    "curl https://$API.execute-api.ap-south-1.amazonaws.com/notes",
  ],
  "c9-websites": [
    "aws s3 mb s3://asha-site-2026",
    "aws s3 cp index.html s3://asha-site-2026/",
    "aws s3 cp error.html s3://asha-site-2026/",
    "aws s3 website s3://asha-site-2026 --index-document index.html --error-document error.html",
    "aws s3api delete-public-access-block --bucket asha-site-2026",
    "aws s3api put-bucket-policy --bucket asha-site-2026 --policy '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::asha-site-2026/*\"}]}'",
    "curl http://asha-site-2026.s3-website.ap-south-1.amazonaws.com",
    "D=$(aws cloudfront create-distribution --origin-domain-name asha-site-2026.s3.ap-south-1.amazonaws.com --default-root-object index.html --query Distribution.Id --output text)",
    "CF=$(aws cloudfront get-distribution --id $D --query Distribution.DomainName --output text)",
    "aws cloudfront wait distribution-deployed --id $D",
    "curl -i https://$CF",
    "curl -i https://$CF",
    "OAC=$(aws cloudfront create-origin-access-control --origin-access-control-config Name=site-oac,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3 --query OriginAccessControl.Id --output text)",
    "ETAG=$(aws cloudfront get-distribution-config --id $D --query ETag --output text)",
    "aws cloudfront get-distribution-config --id $D --query DistributionConfig > dist.json",
    "jq \".Origins.Items[0].OriginAccessControlId = \\\"$OAC\\\"\" dist.json > dist-oac.json",
    "aws cloudfront update-distribution --id $D --if-match $ETAG --distribution-config file://dist-oac.json",
    "aws s3api put-bucket-policy --bucket asha-site-2026 --policy '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"cloudfront.amazonaws.com\"},\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::asha-site-2026/*\",\"Condition\":{\"StringEquals\":{\"AWS:SourceArn\":\"arn:aws:cloudfront::123456789012:distribution/'$D'\"}}}]}'",
    "aws s3api put-public-access-block --bucket asha-site-2026 --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
    "echo '<h1>Version two</h1>' > index.html",
    "aws s3 cp index.html s3://asha-site-2026/",
    "aws cloudfront create-invalidation --distribution-id $D --paths \"/*\"",
    "curl -i https://$CF",
  ],
  "c10-eventbridge": [
    `echo '${TRUST}' > trust.json`,
    "aws iam create-role --role-name report-role --assume-role-policy-document file://trust.json",
    "aws iam attach-role-policy --role-name report-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    "zip report.zip report.mjs",
    "aws lambda create-function --function-name nightly-report --runtime nodejs20.x --handler report.handler --role arn:aws:iam::123456789012:role/report-role --zip-file fileb://report.zip",
    "aws lambda wait function-active-v2 --function-name nightly-report",
    "aws events put-rule --name every-5-minutes --schedule-expression \"rate(5 minutes)\"",
    "aws events put-targets --rule every-5-minutes --targets Id=report,Arn=arn:aws:lambda:ap-south-1:123456789012:function:nightly-report",
    "sleep 600",
    "aws cloudwatch get-metric-statistics --namespace AWS/Events --metric-name FailedInvocations --dimensions Name=RuleName,Value=every-5-minutes --statistics Sum --period 3600 --start-time 2026-01-01T00:00:00Z --end-time 2030-01-01T00:00:00Z",
    "aws lambda add-permission --function-name nightly-report --statement-id events --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn arn:aws:events:ap-south-1:123456789012:rule/every-5-minutes",
    "sleep 600",
    "aws events put-rule --name weekday-mornings --schedule-expression \"cron(30 3 ? * MON-FRI *)\"",
    "aws sqs create-queue --queue-name big-orders",
    "aws events put-rule --name big-orders --event-pattern file://pattern.json",
    "aws events put-targets --rule big-orders --targets Id=queue,Arn=arn:aws:sqs:ap-south-1:123456789012:big-orders",
    "aws events put-events --entries file://orders.json",
  ],
  "c11-step-functions": [
    `echo '${TRUST}' > trust.json`,
    "aws iam create-role --role-name order-fn-role --assume-role-policy-document file://trust.json",
    "aws iam attach-role-policy --role-name order-fn-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
    "zip steps.zip steps.mjs",
    "aws lambda create-function --function-name order-check-stock --runtime nodejs20.x --handler steps.checkStock --role arn:aws:iam::123456789012:role/order-fn-role --zip-file fileb://steps.zip",
    "aws lambda create-function --function-name order-charge-card --runtime nodejs20.x --handler steps.chargeCard --role arn:aws:iam::123456789012:role/order-fn-role --zip-file fileb://steps.zip",
    "aws lambda wait function-active-v2 --function-name order-charge-card",
    "aws iam create-role --role-name order-flow-role --assume-role-policy-document file://sfn-trust.json",
    "aws stepfunctions create-state-machine --name order-flow --definition file://order-flow.json --role-arn arn:aws:iam::123456789012:role/order-flow-role",
    "EXEC=$(aws stepfunctions start-execution --state-machine-arn arn:aws:states:ap-south-1:123456789012:stateMachine:order-flow --input '{\"item\":\"mug\",\"amount\":499}' --query executionArn --output text)",
    "aws iam put-role-policy --role-name order-flow-role --policy-name invoke-order-steps --policy-document '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"lambda:InvokeFunction\",\"Resource\":\"arn:aws:lambda:ap-south-1:123456789012:function:order-*\"}]}'",
    "EXEC=$(aws stepfunctions start-execution --state-machine-arn arn:aws:states:ap-south-1:123456789012:stateMachine:order-flow --input '{\"item\":\"mug\",\"amount\":499}' --query executionArn --output text)",
    "aws stepfunctions describe-execution --execution-arn $EXEC --query status",
    "sleep 60",
    "aws stepfunctions describe-execution --execution-arn $EXEC",
    "aws stepfunctions get-execution-history --execution-arn $EXEC",
    "aws stepfunctions start-execution --state-machine-arn arn:aws:states:ap-south-1:123456789012:stateMachine:order-flow --input '{\"item\":\"mug\",\"amount\":9000}'",
    "aws stepfunctions start-execution --state-machine-arn arn:aws:states:ap-south-1:123456789012:stateMachine:order-flow --input '{\"item\":\"teapot\",\"amount\":900}'",
  ],
  "c12-mystery": [
    "lab-setup broken-shop",
    "aws s3api put-bucket-policy --bucket acme-shop-site --policy '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::acme-shop-site/*\"}]}'",
    "aws iam put-role-policy --role-name save-order-role --policy-name write-orders --policy-document '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"dynamodb:PutItem\",\"Resource\":\"arn:aws:dynamodb:ap-south-1:123456789012:table/Orders\"}]}'",
    "U=$(aws lambda list-event-source-mappings --function-name save-order --query 'EventSourceMappings[0].UUID' --output text)",
    "aws lambda update-event-source-mapping --uuid $U --enabled",
    "aws lambda add-permission --function-name nightly-cleanup --statement-id events --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn arn:aws:events:ap-south-1:123456789012:rule/nightly-cleanup",
    "sleep 86400",
  ],
};

describe("every AWS lab can be completed with the commands a learner types", () => {
  for (const labDef of AWS_LABS) {
    it(labDef.slug, async () => {
      const lab = new AwsLab(freshState());
      for (const [name, text] of Object.entries(FILES[labDef.slug] ?? {})) lab.state.files[`/home/you/${name}`] = text;
      const history: HistoryEntry[] = [];
      const done = new Set<string>();
      for (const line of SCRIPTS[labDef.slug]) {
        const r = await lab.exec(line);
        history.push({
          line,
          code: r.code,
          out: r.chunks.filter((c) => c.stream === "out").map((c) => c.text).join(""),
          err: r.chunks.filter((c) => c.stream === "err").map((c) => c.text).join(""),
          t: 0,
        });
        // Steps tick off as you go, like in the lesson.
        for (const st of labDef.steps) if (st.done(lab.state, history)) done.add(st.id);
      }
      const missing = labDef.steps.filter((s) => !done.has(s.id)).map((s) => s.id);
      if (missing.length) {
        const tail = history.slice(-4).map((e) => `$ ${e.line}\n${e.out}${e.err}`).join("\n");
        throw new Error(`Steps not done: ${missing.join(", ")}\n${tail}`);
      }
      expect(missing).toEqual([]);
    });
  }
});
