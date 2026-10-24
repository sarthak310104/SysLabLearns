import { UsageError, type Call, type Service } from "./cli";
import { decide, evaluate, MANAGED, managedArn, policiesFor, policyByArn, safeParse, SERVICE_ROLE_MANAGED, type Principal } from "./iam-eval";
import { ACCOUNT_ID, iso, md5, now, type IamRole, type IamUser } from "./state";

const idFor = (prefix: string, name: string) => prefix + md5(name).slice(0, 17).toUpperCase();

function userView(u: IamUser) {
  return { Path: "/", UserName: u.name, UserId: idFor("AIDA", u.name), Arn: u.arn, CreateDate: iso(u.createdAt) };
}

function roleView(r: IamRole) {
  return {
    Path: "/",
    RoleName: r.name,
    RoleId: idFor("AROA", r.name),
    Arn: r.arn,
    CreateDate: iso(r.createdAt),
    AssumeRolePolicyDocument: safeParse(r.trust) ?? r.trust,
    ...(r.description ? { Description: r.description } : {}),
    MaxSessionDuration: 3600,
  };
}

function needUser(c: Call, name: string): IamUser {
  const u = c.state.iam.users[name];
  if (!u) throw c.error("NoSuchEntity", `The user with name ${name} cannot be found.`);
  return u;
}
function needRole(c: Call, name: string): IamRole {
  const r = c.state.iam.roles[name];
  if (!r) throw c.error("NoSuchEntity", `The role with name ${name} cannot be found.`);
  return r;
}

function validPolicy(c: Call, doc: string, what = "MalformedPolicyDocument"): void {
  const d = safeParse(doc);
  if (!d) throw c.error(what, "Syntax errors in policy.");
  if (!d.Statement) throw c.error(what, "Policy document must contain a Statement.");
  const sts = Array.isArray(d.Statement) ? d.Statement : [d.Statement];
  for (const st of sts) {
    if (st.Effect !== "Allow" && st.Effect !== "Deny") throw c.error(what, `Statement Effect must be "Allow" or "Deny".`);
    if (!st.Action && !st.NotAction) throw c.error(what, "Policy statement must contain actions.");
  }
}

function attach(c: Call, list: string[], arnIn: string): void {
  if (!policyByArn(c.state, arnIn)) {
    const hint = Object.keys({ ...MANAGED, ...SERVICE_ROLE_MANAGED }).find((n) => arnIn.endsWith("/" + n));
    throw c.error("NoSuchEntity", `Policy ${arnIn} does not exist or is not attachable.${hint ? ` (Did you mean ${managedArn(hint)}?)` : ""}`);
  }
  if (!list.includes(arnIn)) list.push(arnIn);
}

function attachedView(list: string[]) {
  return { AttachedPolicies: list.map((a) => ({ PolicyName: a.split("/").pop(), PolicyArn: a })) };
}

const iam: Service = {
  blurb: "Identity and Access Management: users, roles and what they're allowed to do",
  commands: {
    "create-user": (c) => {
      const name = c.str("user-name", true);
      c.authorize("iam:CreateUser", `arn:aws:iam::${ACCOUNT_ID}:user/${name}`);
      if (c.state.iam.users[name]) throw c.error("EntityAlreadyExists", `User with name ${name} already exists.`);
      const u: IamUser = { name, arn: `arn:aws:iam::${ACCOUNT_ID}:user/${name}`, createdAt: now(c.state), attached: [], inline: {}, groups: [] };
      c.state.iam.users[name] = u;
      return { User: userView(u) };
    },
    "get-user": (c) => {
      const name = c.str("user-name") ?? (c.principal.kind === "user" ? c.principal.name : "");
      c.authorize("iam:GetUser", `arn:aws:iam::${ACCOUNT_ID}:user/${name}`);
      return { User: userView(needUser(c, name)) };
    },
    "list-users": (c) => {
      c.authorize("iam:ListUsers", "*");
      return { Users: Object.values(c.state.iam.users).map(userView) };
    },
    "delete-user": (c) => {
      const u = needUser(c, c.str("user-name", true));
      c.authorize("iam:DeleteUser", u.arn);
      if (u.name === "you") throw c.error("DeleteConflict", "That's you: the lab won't let you delete the user you're signed in as.");
      if (u.attached.length || Object.keys(u.inline).length) throw c.error("DeleteConflict", "Cannot delete entity, must detach all policies first.");
      if (u.keys?.length) throw c.error("DeleteConflict", "Cannot delete entity, must delete access keys first.");
      delete c.state.iam.users[u.name];
      for (const [p, v] of Object.entries(c.state.profiles)) if (v.user === u.name) delete c.state.profiles[p];
    },
    "create-access-key": (c) => {
      const name = c.str("user-name") ?? c.principal.name;
      const u = needUser(c, name);
      c.authorize("iam:CreateAccessKey", u.arn);
      if ((u.keys?.length ?? 0) >= 2) throw c.error("LimitExceeded", "Cannot exceed quota for AccessKeysPerUser: 2");
      const id = "AKIA" + md5(name + now(c.state) + c.state.seq++).slice(0, 16).toUpperCase();
      (u.keys ??= []).push(id);
      return {
        AccessKey: {
          UserName: name,
          AccessKeyId: id,
          Status: "Active",
          SecretAccessKey: btoa(md5(id) + md5(id + "s")).slice(0, 40),
          CreateDate: iso(now(c.state)),
        },
      };
    },
    "list-access-keys": (c) => {
      const u = needUser(c, c.str("user-name") ?? c.principal.name);
      return { AccessKeyMetadata: (u.keys ?? []).map((k) => ({ UserName: u.name, AccessKeyId: k, Status: "Active", CreateDate: iso(u.createdAt) })) };
    },
    "delete-access-key": (c) => {
      const u = needUser(c, c.str("user-name") ?? c.principal.name);
      const id = c.str("access-key-id", true);
      if (!u.keys?.includes(id)) throw c.error("NoSuchEntity", `The Access Key with id ${id} cannot be found.`);
      u.keys = u.keys.filter((k) => k !== id);
    },
    "attach-user-policy": (c) => {
      const u = needUser(c, c.str("user-name", true));
      c.authorize("iam:AttachUserPolicy", u.arn);
      attach(c, u.attached, c.str("policy-arn", true));
    },
    "detach-user-policy": (c) => {
      const u = needUser(c, c.str("user-name", true));
      c.authorize("iam:DetachUserPolicy", u.arn);
      const a = c.str("policy-arn", true);
      if (!u.attached.includes(a)) throw c.error("NoSuchEntity", `Policy ${a} was not found.`);
      u.attached = u.attached.filter((x) => x !== a);
    },
    "list-attached-user-policies": (c) => attachedView(needUser(c, c.str("user-name", true)).attached),
    "put-user-policy": (c) => {
      const u = needUser(c, c.str("user-name", true));
      c.authorize("iam:PutUserPolicy", u.arn);
      const doc = c.str("policy-document", true);
      validPolicy(c, doc);
      u.inline[c.str("policy-name", true)] = doc;
    },
    "list-user-policies": (c) => ({ PolicyNames: Object.keys(needUser(c, c.str("user-name", true)).inline) }),
    "get-user-policy": (c) => {
      const u = needUser(c, c.str("user-name", true));
      const n = c.str("policy-name", true);
      if (!u.inline[n]) throw c.error("NoSuchEntity", `The user policy with name ${n} cannot be found.`);
      return { UserName: u.name, PolicyName: n, PolicyDocument: safeParse(u.inline[n]) };
    },
    "delete-user-policy": (c) => {
      const u = needUser(c, c.str("user-name", true));
      const n = c.str("policy-name", true);
      if (!u.inline[n]) throw c.error("NoSuchEntity", `The user policy with name ${n} cannot be found.`);
      delete u.inline[n];
    },
    "create-role": (c) => {
      const name = c.str("role-name", true);
      c.authorize("iam:CreateRole", `arn:aws:iam::${ACCOUNT_ID}:role/${name}`);
      if (c.state.iam.roles[name]) throw c.error("EntityAlreadyExists", `Role with name ${name} already exists.`);
      const trust = c.str("assume-role-policy-document", true);
      const d = safeParse(trust);
      if (!d) throw c.error("MalformedPolicyDocument", "This policy contains invalid Json");
      const r: IamRole = { name, arn: `arn:aws:iam::${ACCOUNT_ID}:role/${name}`, createdAt: now(c.state), trust, attached: [], inline: {}, description: c.str("description") };
      c.state.iam.roles[name] = r;
      return { Role: roleView(r) };
    },
    "get-role": (c) => ({ Role: roleView(needRole(c, c.str("role-name", true))) }),
    "list-roles": (c) => {
      c.authorize("iam:ListRoles", "*");
      return { Roles: Object.values(c.state.iam.roles).map(roleView) };
    },
    "delete-role": (c) => {
      const r = needRole(c, c.str("role-name", true));
      c.authorize("iam:DeleteRole", r.arn);
      if (r.attached.length || Object.keys(r.inline).length) throw c.error("DeleteConflict", "Cannot delete entity, must detach all policies first.");
      delete c.state.iam.roles[r.name];
    },
    "update-assume-role-policy": (c) => {
      const r = needRole(c, c.str("role-name", true));
      const doc = c.str("policy-document", true);
      if (!safeParse(doc)) throw c.error("MalformedPolicyDocument", "This policy contains invalid Json");
      r.trust = doc;
    },
    "attach-role-policy": (c) => {
      const r = needRole(c, c.str("role-name", true));
      c.authorize("iam:AttachRolePolicy", r.arn);
      attach(c, r.attached, c.str("policy-arn", true));
    },
    "detach-role-policy": (c) => {
      const r = needRole(c, c.str("role-name", true));
      c.authorize("iam:DetachRolePolicy", r.arn);
      const a = c.str("policy-arn", true);
      if (!r.attached.includes(a)) throw c.error("NoSuchEntity", `Policy ${a} was not found.`);
      r.attached = r.attached.filter((x) => x !== a);
    },
    "list-attached-role-policies": (c) => attachedView(needRole(c, c.str("role-name", true)).attached),
    "put-role-policy": (c) => {
      const r = needRole(c, c.str("role-name", true));
      c.authorize("iam:PutRolePolicy", r.arn);
      const doc = c.str("policy-document", true);
      validPolicy(c, doc);
      r.inline[c.str("policy-name", true)] = doc;
    },
    "list-role-policies": (c) => ({ PolicyNames: Object.keys(needRole(c, c.str("role-name", true)).inline) }),
    "get-role-policy": (c) => {
      const r = needRole(c, c.str("role-name", true));
      const n = c.str("policy-name", true);
      if (!r.inline[n]) throw c.error("NoSuchEntity", `The role policy with name ${n} cannot be found.`);
      return { RoleName: r.name, PolicyName: n, PolicyDocument: safeParse(r.inline[n]) };
    },
    "delete-role-policy": (c) => {
      const r = needRole(c, c.str("role-name", true));
      const n = c.str("policy-name", true);
      if (!r.inline[n]) throw c.error("NoSuchEntity", `The role policy with name ${n} cannot be found.`);
      delete r.inline[n];
    },
    "create-policy": (c) => {
      const name = c.str("policy-name", true);
      const arnOut = `arn:aws:iam::${ACCOUNT_ID}:policy/${name}`;
      c.authorize("iam:CreatePolicy", arnOut);
      if (c.state.iam.policies[name]) throw c.error("EntityAlreadyExists", `A policy called ${name} already exists. Duplicate names are not allowed.`);
      const doc = c.str("policy-document", true);
      validPolicy(c, doc);
      c.state.iam.policies[name] = { name, arn: arnOut, document: doc, createdAt: now(c.state) };
      return {
        Policy: { PolicyName: name, PolicyId: idFor("ANPA", name), Arn: arnOut, Path: "/", DefaultVersionId: "v1", AttachmentCount: 0, PermissionsBoundaryUsageCount: 0, IsAttachable: true, CreateDate: iso(now(c.state)), UpdateDate: iso(now(c.state)) },
      };
    },
    "get-policy": (c) => {
      const a = c.str("policy-arn", true);
      const own = Object.values(c.state.iam.policies).find((p) => p.arn === a);
      const name = own?.name ?? a.split("/").pop()!;
      if (!policyByArn(c.state, a)) throw c.error("NoSuchEntity", `Policy ${a} was not found.`);
      return { Policy: { PolicyName: name, Arn: a, Path: "/", DefaultVersionId: "v1", IsAttachable: true, Description: (MANAGED[name] ?? SERVICE_ROLE_MANAGED[name])?.description } };
    },
    "get-policy-version": (c) => {
      const a = c.str("policy-arn", true);
      const d = policyByArn(c.state, a);
      if (!d) throw c.error("NoSuchEntity", `Policy ${a} was not found.`);
      return { PolicyVersion: { Document: d, VersionId: c.str("version-id") ?? "v1", IsDefaultVersion: true } };
    },
    "list-policies": (c) => {
      const scope = c.str("scope") ?? "All";
      const aws = [...Object.entries(MANAGED), ...Object.entries(SERVICE_ROLE_MANAGED)].map(([n, p]) => ({ PolicyName: n, Arn: managedArn(n)!, Path: managedArn(n)!.includes("service-role") ? "/service-role/" : "/", DefaultVersionId: "v1", IsAttachable: true, Description: p.description }));
      const local = Object.values(c.state.iam.policies).map((p) => ({ PolicyName: p.name, Arn: p.arn, Path: "/", DefaultVersionId: "v1", IsAttachable: true }));
      return { Policies: scope === "AWS" ? aws : scope === "Local" ? local : [...local, ...aws] };
    },
    "delete-policy": (c) => {
      const a = c.str("policy-arn", true);
      const own = Object.values(c.state.iam.policies).find((p) => p.arn === a);
      if (!own) throw c.error("NoSuchEntity", `Policy ${a} was not found.`);
      const inUse = [...Object.values(c.state.iam.users), ...Object.values(c.state.iam.roles)].some((e) => e.attached.includes(a));
      if (inUse) throw c.error("DeleteConflict", "Cannot delete a policy attached to entities.");
      delete c.state.iam.policies[own.name];
    },
    "simulate-principal-policy": (c) => {
      const src = c.str("policy-source-arn", true);
      const actions = c.list("action-names");
      const resources = c.list("resource-arns");
      if (!actions.length) throw new UsageError("the following arguments are required: --action-names");
      const m = src.match(/:(user|role)\/(.+)$/);
      if (!m) throw c.error("InvalidInput", "Invalid ARN: use a user or role ARN");
      const p: Principal = { kind: m[1] as "user" | "role", name: m[2], arn: src };
      if (p.kind === "user") needUser(c, p.name);
      else needRole(c, p.name);
      const docs = policiesFor(c.state, p);
      const results = actions.flatMap((a) =>
        (resources.length ? resources : ["*"]).map((r) => {
          const d = evaluate(docs, a, r);
          return { EvalActionName: a, EvalResourceName: r, EvalDecision: d === "allow" ? "allowed" : d === "explicit-deny" ? "explicitDeny" : "implicitDeny", MatchedStatements: [], MissingContextValues: [] };
        }),
      );
      return { EvaluationResults: results, IsTruncated: false };
    },
  },
};

const sts: Service = {
  blurb: "Security Token Service: who am I?",
  commands: {
    "get-caller-identity": (c) => ({
      UserId: c.principal.kind === "user" ? idFor("AIDA", c.principal.name) : `${idFor("AROA", c.principal.name)}:session`,
      Account: ACCOUNT_ID,
      Arn: c.principal.arn,
    }),
  },
};

export const IAM_SERVICES = { iam, sts };
export { decide };
