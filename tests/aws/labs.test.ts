import { describe, expect, it } from "vitest";
import { AWS_LABS, type HistoryEntry } from "@/content/aws/labs";
import { AwsLab } from "@/engine/aws/shell";
import { freshState } from "@/engine/aws/state";

const TRUST = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}`;

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
};

describe("every AWS lab can be completed with the commands a learner types", () => {
  for (const labDef of AWS_LABS) {
    it(labDef.slug, async () => {
      const lab = new AwsLab(freshState());
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
