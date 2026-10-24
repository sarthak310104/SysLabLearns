import { describe, expect, it } from "vitest";
import { lab } from "./helpers";

const TRUST = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}`;

async function setupFunction(run: Awaited<ReturnType<typeof lab>>["run"], code: string, name = "hello", extraPolicies: string[] = []) {
  await run(`echo '${TRUST}' > trust.json`);
  await run(`aws iam create-role --role-name ${name}-role --assume-role-policy-document file://trust.json`);
  await run(`aws iam attach-role-policy --role-name ${name}-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`);
  for (const p of extraPolicies) await run(`aws iam attach-role-policy --role-name ${name}-role --policy-arn ${p}`);
  await run(`cat > index.mjs`);
  const r = await run(`printf '%s' '${code.replace(/'/g, "'\\''")}' > index.mjs`);
  void r;
  await run("zip function.zip index.mjs");
  const c = await run(
    `aws lambda create-function --function-name ${name} --runtime nodejs20.x --handler index.handler --role arn:aws:iam::123456789012:role/${name}-role --zip-file fileb://function.zip`,
  );
  return c;
}

describe("Lambda", () => {
  it("packages, waits for Active, invokes, and writes logs", async () => {
    const { run } = lab();
    const created = await setupFunction(run, `export const handler = async (event) => { console.log("got", event); return { hello: event.name }; };`);
    expect(created.json().State).toBe("Pending");
    const early = await run(`aws lambda invoke --function-name hello --cli-binary-format raw-in-base64-out --payload '{"name":"Asha"}' out.json`);
    expect(early.err).toMatch(/Pending/);
    await run("aws lambda wait function-active-v2 --function-name hello");
    const noFlag = await run(`aws lambda invoke --function-name hello --payload '{"name":"Asha"}' out.json`);
    expect(noFlag.err).toMatch(/Invalid base64/);
    const ok = await run(`aws lambda invoke --function-name hello --cli-binary-format raw-in-base64-out --payload '{"name":"Asha"}' out.json`);
    expect(ok.json().StatusCode).toBe(200);
    expect((await run("cat out.json")).out).toBe('{"hello":"Asha"}');
    const logs = (await run("aws logs tail /aws/lambda/hello")).out;
    expect(logs).toMatch(/START RequestId/);
    expect(logs).toMatch(/INFO\tgot \{/);
    expect(logs).toMatch(/Init Duration/);
  });

  it("catches the classic mistakes", async () => {
    const { run } = lab();
    await run(`printf '%s' 'export const handler = async () => 1;' > index.js`);
    await run("zip function.zip index.js");
    await run(`aws iam create-role --role-name bad-trust --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'`);
    expect((await run("aws lambda create-function --function-name f --runtime nodejs20.x --handler index.handler --role arn:aws:iam::123456789012:role/bad-trust --zip-file fileb://function.zip")).err).toMatch(/cannot be assumed by Lambda/);
    await run(`aws iam update-assume-role-policy --role-name bad-trust --policy-document '${TRUST}'`);
    expect((await run("aws lambda create-function --function-name f --runtime nodejs20.x --handler index.handler --role arn:aws:iam::123456789012:role/bad-trust --zip-file fileb://index.js")).err).toMatch(/Could not unzip/);
    await run("aws lambda create-function --function-name f --runtime nodejs20.x --handler index.handler --role arn:aws:iam::123456789012:role/bad-trust --zip-file fileb://function.zip");
    await run("sleep 2");
    const r = await run("aws lambda invoke --function-name f out.json");
    expect(r.json().FunctionError).toBe("Unhandled");
    expect((await run("cat out.json")).out).toMatch(/Unexpected token 'export'/);
    // No logging permission: no log group appears.
    expect((await run("aws logs describe-log-groups")).json().logGroups).toHaveLength(0);
  });

  it("an SQS trigger processes messages, retries failures, then dead-letters them", async () => {
    const { run } = lab();
    await run("aws sqs create-queue --queue-name work-dlq");
    await run(`aws sqs create-queue --queue-name work --attributes '{"VisibilityTimeout":"10","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"arn:aws:sqs:ap-south-1:123456789012:work-dlq\\",\\"maxReceiveCount\\":\\"2\\"}"}'`);
    await setupFunction(
      run,
      `export const handler = async (event) => { for (const r of event.Records) { if (r.body === "bad") throw new Error("cannot process " + r.body); console.log("processed", r.body); } };`,
      "worker",
    );
    await run("sleep 2");
    const denied = await run("aws lambda create-event-source-mapping --function-name worker --event-source-arn arn:aws:sqs:ap-south-1:123456789012:work");
    expect(denied.err).toMatch(/does not have permissions to call ReceiveMessage/);
    await run("aws iam attach-role-policy --role-name worker-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole");
    expect((await run("aws lambda create-event-source-mapping --function-name worker --event-source-arn arn:aws:sqs:ap-south-1:123456789012:work --batch-size 1")).code).toBe(0);
    const Q = "https://sqs.ap-south-1.amazonaws.com/123456789012/work";
    await run(`aws sqs send-message --queue-url ${Q} --message-body good`);
    expect((await run("aws logs tail /aws/lambda/worker")).out).toMatch(/processed good/);
    await run(`aws sqs send-message --queue-url ${Q} --message-body bad`);
    await run("sleep 11");
    await run("true");
    await run("sleep 11");
    await run("true");
    const dl = (await run("aws sqs receive-message --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/work-dlq")).json();
    expect(dl.Messages[0].Body).toBe("bad");
  });

  it("API Gateway calls a function that writes to DynamoDB, once permissions are right", async () => {
    const { run } = lab();
    await run("aws dynamodb create-table --table-name Notes --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST");
    const code = `import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const handler = async (event) => {
  if (event.requestContext.http.method === "POST") {
    const note = JSON.parse(event.body);
    await db.send(new PutCommand({ TableName: process.env.TABLE, Item: { id: note.id, text: note.text } }));
    return { statusCode: 201, body: JSON.stringify({ saved: note.id }) };
  }
  const out = await db.send(new ScanCommand({ TableName: process.env.TABLE }));
  return { statusCode: 200, body: JSON.stringify(out.Items) };
};`;
    await setupFunction(run, code, "notes");
    await run("aws lambda update-function-configuration --function-name notes --environment Variables={TABLE=Notes}");
    await run("sleep 3");
    const api = (await run("aws apigatewayv2 create-api --name notes-api --protocol-type HTTP --target arn:aws:lambda:ap-south-1:123456789012:function:notes")).json();
    const url = api.ApiEndpoint as string;
    expect((await run(`curl ${url}/`)).out).toMatch(/Internal Server Error/);
    await run(`aws lambda add-permission --function-name notes --statement-id apigw --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:ap-south-1:123456789012:${api.ApiId}/*"`);
    // The role can't write to DynamoDB yet: the function fails, API Gateway answers 500.
    expect((await run(`curl -X POST ${url}/notes -d '{"id":"n1","text":"hi"}'`)).out).toMatch(/Internal Server Error/);
    expect((await run("aws logs tail /aws/lambda/notes")).out).toMatch(/AccessDeniedException|not authorized to perform: dynamodb:PutItem/);
    await run("aws iam attach-role-policy --role-name notes-role --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess");
    expect((await run(`curl -X POST ${url}/notes -d '{"id":"n1","text":"hi"}'`)).out).toBe('{"saved":"n1"}\n');
    expect((await run(`curl -s ${url}/notes`)).json()).toEqual([{ id: "n1", text: "hi" }]);
    expect((await run(`curl -i ${url}/notes`)).out).toMatch(/^HTTP\/2 200/);
  });
});
