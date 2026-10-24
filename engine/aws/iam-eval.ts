import { ACCOUNT_ID, AwsError, type AwsState, type IamPolicyDoc, type IamStatement } from "./state";

/** Who is making a call: a user (through a CLI profile) or a role (a Lambda function). */
export interface Principal {
  kind: "user" | "role";
  name: string;
  /** The ARN shown in error messages. */
  arn: string;
}

/** The AWS-managed policies the labs use, with their real names and the gist of their rules. */
export const MANAGED: Record<string, { description: string; doc: IamPolicyDoc }> = {
  AdministratorAccess: {
    description: "Full access to everything",
    doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] },
  },
  ReadOnlyAccess: {
    description: "Read anything, change nothing",
    doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["*:Get*", "*:List*", "*:Describe*", "*:Head*", "s3:GetObject"], Resource: "*" }] },
  },
  AmazonS3FullAccess: {
    description: "Full access to every S3 bucket",
    doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:*"], Resource: "*" }] },
  },
  AmazonS3ReadOnlyAccess: {
    description: "List and read every S3 bucket",
    doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:Get*", "s3:List*"], Resource: "*" }] },
  },
  AmazonSQSFullAccess: {
    description: "Full access to every SQS queue",
    doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sqs:*"], Resource: "*" }] },
  },
  AmazonSNSFullAccess: {
    description: "Full access to every SNS topic",
    doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sns:*"], Resource: "*" }] },
  },
  AmazonDynamoDBFullAccess: {
    description: "Full access to every DynamoDB table",
    doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["dynamodb:*"], Resource: "*" }] },
  },
  AmazonDynamoDBReadOnlyAccess: {
    description: "Read every DynamoDB table",
    doc: {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["dynamodb:BatchGetItem", "dynamodb:Describe*", "dynamodb:List*", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"], Resource: "*" }],
    },
  },
  AWSLambda_FullAccess: {
    description: "Full access to Lambda",
    doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["lambda:*", "logs:*"], Resource: "*" }] },
  },
  IAMFullAccess: {
    description: "Full access to IAM",
    doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["iam:*"], Resource: "*" }] },
  },
};

/** Managed policies meant for roles, under arn:aws:iam::aws:policy/service-role/. */
export const SERVICE_ROLE_MANAGED: Record<string, { description: string; doc: IamPolicyDoc }> = {
  AWSLambdaBasicExecutionRole: {
    description: "Lets a Lambda function write its logs to CloudWatch",
    doc: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }] },
  },
  AWSLambdaSQSQueueExecutionRole: {
    description: "Lets a Lambda function read from SQS and write logs",
    doc: {
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource: "*" },
        { Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" },
      ],
    },
  },
};

export function managedArn(name: string): string | null {
  if (MANAGED[name]) return `arn:aws:iam::aws:policy/${name}`;
  if (SERVICE_ROLE_MANAGED[name]) return `arn:aws:iam::aws:policy/service-role/${name}`;
  return null;
}

/** Look up a managed policy document by ARN (AWS's or the account's own). */
export function policyByArn(state: AwsState, arn: string): IamPolicyDoc | null {
  let m = arn.match(/^arn:aws:iam::aws:policy\/service-role\/(.+)$/);
  if (m) return SERVICE_ROLE_MANAGED[m[1]]?.doc ?? null;
  m = arn.match(/^arn:aws:iam::aws:policy\/(.+)$/);
  if (m) return MANAGED[m[1]]?.doc ?? null;
  const own = Object.values(state.iam.policies).find((p) => p.arn === arn);
  return own ? safeParse(own.document) : null;
}

export function safeParse(doc: string): IamPolicyDoc | null {
  try {
    return JSON.parse(doc) as IamPolicyDoc;
  } catch {
    return null;
  }
}

const asList = (x: string | string[] | undefined): string[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
export const statements = (d: IamPolicyDoc): IamStatement[] => (Array.isArray(d.Statement) ? d.Statement : d.Statement ? [d.Statement] : []);

/** IAM wildcards: * matches anything, ? one character. Actions compare case-insensitively. */
export function wildcard(pattern: string, value: string, ci = false): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", ci ? "i" : "");
  return re.test(value);
}

function statementMatches(st: IamStatement, action: string, resource: string): boolean {
  const actionOk = st.NotAction ? !asList(st.NotAction).some((a) => wildcard(a, action, true)) : asList(st.Action).some((a) => wildcard(a, action, true));
  if (!actionOk) return false;
  const resources = asList(st.Resource);
  if (!resources.length) return true; // resource policies may omit Resource
  return resources.some((r) => wildcard(r, resource));
}

/** Every identity policy that applies to a principal. */
export function policiesFor(state: AwsState, p: Principal): IamPolicyDoc[] {
  const docs: IamPolicyDoc[] = [];
  const entity = p.kind === "user" ? state.iam.users[p.name] : state.iam.roles[p.name];
  if (!entity) return docs;
  for (const arn of entity.attached) {
    const d = policyByArn(state, arn);
    if (d) docs.push(d);
  }
  for (const doc of Object.values(entity.inline)) {
    const d = safeParse(doc);
    if (d) docs.push(d);
  }
  return docs;
}

export type Decision = "allow" | "explicit-deny" | "implicit-deny";

export function evaluate(docs: IamPolicyDoc[], action: string, resource: string): Decision {
  let allowed = false;
  for (const d of docs) {
    for (const st of statements(d)) {
      if (!statementMatches(st, action, resource)) continue;
      if (st.Effect === "Deny") return "explicit-deny";
      if (st.Effect === "Allow") allowed = true;
    }
  }
  return allowed ? "allow" : "implicit-deny";
}

const DENIED_CODE: Record<string, string> = {
  s3: "AccessDenied",
  sqs: "AccessDenied",
  sns: "AuthorizationError",
  iam: "AccessDenied",
  dynamodb: "AccessDeniedException",
  lambda: "AccessDeniedException",
  logs: "AccessDeniedException",
  apigateway: "AccessDeniedException",
  sts: "AccessDenied",
};

export function decide(state: AwsState, p: Principal, action: string, resource: string): Decision {
  return evaluate(policiesFor(state, p), action, resource);
}

export function authorize(state: AwsState, p: Principal, action: string, resource: string, operation: string): void {
  const d = decide(state, p, action, resource);
  if (d === "allow") return;
  const svc = action.split(":")[0];
  const why =
    d === "explicit-deny" ? `with an explicit deny in an identity-based policy` : `because no identity-based policy allows the ${action} action`;
  const on = resource === "*" ? "" : ` on resource: ${resource}`;
  throw new AwsError(DENIED_CODE[svc] ?? "AccessDenied", `User: ${p.arn} is not authorized to perform: ${action}${on} ${why}`, operation);
}

export function principalForProfile(state: AwsState, profile: string): Principal {
  const user = state.profiles[profile]?.user ?? "you";
  return { kind: "user", name: user, arn: `arn:aws:iam::${ACCOUNT_ID}:user/${user}` };
}

export function principalForRole(roleArn: string, session: string): Principal {
  const name = roleArn.split("/").pop() ?? roleArn;
  return { kind: "role", name, arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/${name}/${session}` };
}

/** Does a role's trust policy let this AWS service assume it? */
export function trusts(trustDoc: string, service: string): boolean {
  const d = safeParse(trustDoc);
  if (!d) return false;
  for (const st of statements(d)) {
    if (st.Effect !== "Allow") continue;
    if (!asList(st.Action).some((a) => wildcard(a, "sts:AssumeRole", true))) continue;
    const pr = st.Principal as { Service?: string | string[] } | string | undefined;
    if (pr === "*") return true;
    if (pr && typeof pr === "object" && asList(pr.Service).includes(service)) return true;
  }
  return false;
}
