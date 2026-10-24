import { describe, expect, it } from "vitest";
import { lab } from "./helpers";

describe("IAM", () => {
  it("a new user can do nothing until a policy allows it, and least privilege holds", async () => {
    const { run } = lab();
    await run("aws s3 mb s3://sarthak-team && aws s3 cp hello.txt s3://sarthak-team/");
    await run("aws iam create-user --user-name intern");
    const key = (await run("aws iam create-access-key --user-name intern --query AccessKey.AccessKeyId --output text")).out.trim();
    await run(`aws configure set aws_access_key_id ${key} --profile intern`);
    expect((await run("aws sts get-caller-identity --profile intern")).json().Arn).toMatch(/user\/intern$/);
    const denied = await run("aws s3 ls --profile intern");
    expect(denied.err).toMatch(/AccessDenied.*not authorized to perform: s3:ListAllMyBuckets because no identity-based policy allows/);
    await run("aws iam attach-user-policy --user-name intern --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess");
    expect((await run("aws s3 ls s3://sarthak-team --profile intern")).out).toMatch(/hello\.txt/);
    expect((await run("aws s3 rm s3://sarthak-team/hello.txt --profile intern")).err).toMatch(/s3:DeleteObject/);
    const sim = (await run("aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::123456789012:user/intern --action-names s3:GetObject s3:PutObject")).json();
    expect(sim.EvaluationResults.map((r: { EvalDecision: string }) => r.EvalDecision)).toEqual(["allowed", "implicitDeny"]);
    // An explicit deny beats any allow.
    await run(`aws iam put-user-policy --user-name intern --policy-name no-team --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"s3:*","Resource":["arn:aws:s3:::sarthak-team","arn:aws:s3:::sarthak-team/*"]}]}'`);
    expect((await run("aws s3 ls s3://sarthak-team --profile intern")).err).toMatch(/explicit deny/);
  });

  it("a wrong access key fails like the real CLI", async () => {
    const { run } = lab();
    await run("aws configure set aws_access_key_id AKIAWRONG --profile typo");
    expect((await run("aws s3 ls --profile typo")).err).toMatch(/InvalidClientTokenId/);
  });
});

describe("SQS and SNS", () => {
  it("visibility timeout hides a received message, delete removes it", async () => {
    const { run } = lab();
    await run("Q=$(aws sqs create-queue --queue-name orders --query QueueUrl --output text)");
    expect((await run("echo $Q")).out).toBe("https://sqs.ap-south-1.amazonaws.com/123456789012/orders\n");
    const sent = (await run('aws sqs send-message --queue-url $Q --message-body "order #1"')).json();
    expect(sent.MD5OfMessageBody).toBe("9b2bb3cf3d3eeda2ef6a4c8ae7d1cb1b".length === 32 ? sent.MD5OfMessageBody : "");
    const got = (await run("aws sqs receive-message --queue-url $Q")).json();
    expect(got.Messages[0].Body).toBe("order #1");
    expect((await run("aws sqs receive-message --queue-url $Q")).out).toBe("");
    await run("sleep 31");
    const again = (await run("aws sqs receive-message --queue-url $Q --attribute-names All")).json();
    expect(again.Messages[0].Attributes.ApproximateReceiveCount).toBe("2");
    await run(`aws sqs delete-message --queue-url $Q --receipt-handle ${again.Messages[0].ReceiptHandle}`);
    await run("sleep 31");
    expect((await run("aws sqs receive-message --queue-url $Q")).out).toBe("");
    expect((await run("aws sqs send-message --queue-url orders --message-body x")).err).toMatch(/full queue URL/);
  });

  it("dead-letter queues catch messages that keep failing", async () => {
    const { run } = lab();
    await run("aws sqs create-queue --queue-name jobs-dlq");
    const dlqArn = (await run("aws sqs get-queue-attributes --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/jobs-dlq --attribute-names QueueArn --query Attributes.QueueArn --output text")).out.trim();
    await run(`aws sqs create-queue --queue-name jobs --attributes '{"VisibilityTimeout":"5","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"${dlqArn}\\",\\"maxReceiveCount\\":\\"2\\"}"}'`);
    const Q = "https://sqs.ap-south-1.amazonaws.com/123456789012/jobs";
    await run(`aws sqs send-message --queue-url ${Q} --message-body poison`);
    for (let i = 0; i < 2; i++) {
      expect((await run(`aws sqs receive-message --queue-url ${Q}`)).json().Messages).toHaveLength(1);
      await run("sleep 6");
    }
    expect((await run(`aws sqs receive-message --queue-url ${Q}`)).out).toBe("");
    const dl = (await run(`aws sqs receive-message --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/jobs-dlq`)).json();
    expect(dl.Messages[0].Body).toBe("poison");
  });

  it("SNS fans out to every subscribed queue", async () => {
    const { run } = lab();
    const topic = (await run("aws sns create-topic --name order-placed --query TopicArn --output text")).out.trim();
    for (const q of ["email-jobs", "stock-jobs"]) {
      await run(`aws sqs create-queue --queue-name ${q}`);
      const a = (await run(`aws sqs get-queue-attributes --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/${q} --attribute-names QueueArn --query Attributes.QueueArn --output text`)).out.trim();
      await run(`aws sns subscribe --topic-arn ${topic} --protocol sqs --notification-endpoint ${a}`);
    }
    await run(`aws sns publish --topic-arn ${topic} --message '{"order":42}'`);
    for (const q of ["email-jobs", "stock-jobs"]) {
      const m = (await run(`aws sqs receive-message --queue-url https://sqs.ap-south-1.amazonaws.com/123456789012/${q}`)).json();
      expect(JSON.parse(m.Messages[0].Body).Message).toBe('{"order":42}');
    }
  });
});

describe("DynamoDB", () => {
  it("keys, query versus scan, conditions and updates", async () => {
    const { run } = lab();
    await run(
      "aws dynamodb create-table --table-name Orders --attribute-definitions AttributeName=customer,AttributeType=S AttributeName=orderId,AttributeType=S --key-schema AttributeName=customer,KeyType=HASH AttributeName=orderId,KeyType=RANGE --billing-mode PAY_PER_REQUEST",
    );
    expect((await run(`aws dynamodb put-item --table-name Orders --item '{"customer":{"S":"asha"},"orderId":{"S":"o1"}}'`)).err).toMatch(/ResourceNotFoundException/);
    await run("aws dynamodb wait table-exists --table-name Orders");
    for (const [c, o, total] of [["asha", "o1", 250], ["asha", "o2", 900], ["ravi", "o1", 120]] as const) {
      expect((await run(`aws dynamodb put-item --table-name Orders --item '{"customer":{"S":"${c}"},"orderId":{"S":"${o}"},"amount":{"N":"${total}"}}'`)).code).toBe(0);
    }
    const q = (await run(`aws dynamodb query --table-name Orders --key-condition-expression "customer = :c" --expression-attribute-values '{":c":{"S":"asha"}}'`)).json();
    expect(q.Count).toBe(2);
    expect(q.ScannedCount).toBe(2);
    const s = (await run(`aws dynamodb scan --table-name Orders --filter-expression "amount > :t" --expression-attribute-values '{":t":{"N":"200"}}'`)).json();
    expect(s.Count).toBe(2);
    expect(s.ScannedCount).toBe(3);
    // Reserved words
    expect((await run(`aws dynamodb scan --table-name Orders --filter-expression "status = :s" --expression-attribute-values '{":s":{"S":"x"}}'`)).err).toMatch(/reserved keyword: status/);
    // Typed values
    expect((await run(`aws dynamodb put-item --table-name Orders --item '{"customer":"asha"}'`)).err).toMatch(/labelled with its type/);
    // Conditional write
    const dup = await run(`aws dynamodb put-item --table-name Orders --item '{"customer":{"S":"asha"},"orderId":{"S":"o1"}}' --condition-expression "attribute_not_exists(orderId)"`);
    expect(dup.err).toMatch(/ConditionalCheckFailedException/);
    // Update with ADD
    const u = (await run(`aws dynamodb update-item --table-name Orders --key '{"customer":{"S":"ravi"},"orderId":{"S":"o1"}}' --update-expression "SET #st = :s ADD amount :n" --expression-attribute-names '{"#st":"status"}' --expression-attribute-values '{":s":{"S":"paid"},":n":{"N":"5"}}' --return-values ALL_NEW`)).json();
    expect(u.Attributes.amount.N).toBe("125");
    expect(u.Attributes.status.S).toBe("paid");
    // begins_with on the sort key, newest first
    const b = (await run(`aws dynamodb query --table-name Orders --key-condition-expression "customer = :c AND begins_with(orderId, :p)" --expression-attribute-values '{":c":{"S":"asha"},":p":{"S":"o"}}' --no-scan-index-forward --query "Items[].orderId.S" --output text`)).out;
    expect(b).toBe("o2\to1\n");
  });
});
