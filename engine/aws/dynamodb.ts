import { arn, UsageError, type Call, type Service } from "./cli";
import {
  applyUpdate,
  checkUnused,
  compare,
  condAttr,
  evalCond,
  ExprError,
  keyParts,
  makeCtx,
  parseCondition,
  parseProjection,
  parseUpdate,
  project,
} from "./ddb-expr";
import { iso, now, type AwsState, type DdbItem, type DdbKeyElement, type DdbTable, type DdbValue } from "./state";

const VALID_TYPES = new Set(["S", "N", "B", "BOOL", "NULL", "M", "L", "SS", "NS", "BS"]);

function wrap<T>(c: Call, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ExprError) throw c.error("ValidationException", e.message);
    throw e;
  }
}

function needTable(c: Call, name: string, action: string): DdbTable {
  c.authorize(action, arn.ddb(name));
  const t = c.state.dynamodb.tables[name];
  if (!t) throw c.error("ResourceNotFoundException", "Requested resource not found");
  return t;
}

function activeTable(c: Call, name: string, action: string): DdbTable {
  const t = needTable(c, name, action);
  if (now(c.state) < t.activeAt) throw c.error("ResourceNotFoundException", "Requested resource not found: Table: " + name + " not found (it is still being created; try: aws dynamodb wait table-exists --table-name " + name + ")");
  return t;
}

function status(state: AwsState, t: DdbTable): string {
  return now(state) < t.activeAt ? "CREATING" : "ACTIVE";
}

function validateItem(c: Call, item: unknown, what = "Item"): DdbItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw c.error("ValidationException", `Invalid ${what}`);
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new UsageError(
        `Parameter validation failed:\nInvalid type for parameter ${what}.${k}, value: ${JSON.stringify(v)}, type: ${typeof v}, valid types: <class 'dict'>\n` +
          `DynamoDB needs each value labelled with its type, like {"${k}": {"S": ${JSON.stringify(String(v))}}} for a string or {"N": "42"} for a number.`,
      );
    }
    const t = Object.keys(v as object)[0];
    if (!VALID_TYPES.has(t)) throw new UsageError(`Parameter validation failed:\nUnknown parameter in ${what}.${k}: "${t}", must be one of: S, N, B, SS, NS, BS, M, L, NULL, BOOL`);
    if (t === "N" && typeof (v as DdbValue).N !== "string") {
      throw new UsageError(`Parameter validation failed:\nInvalid type for parameter ${what}.${k}.N, value: ${(v as DdbValue).N}, type: <class 'int'>, valid types: <class 'str'>\nNumbers are sent as strings: {"N": "${(v as DdbValue).N}"}`);
    }
  }
  return item as DdbItem;
}

function checkKey(c: Call, t: DdbTable, item: DdbItem, onlyKey: boolean): void {
  for (const k of t.keySchema) {
    const v = item[k.AttributeName];
    if (!v) {
      throw c.error("ValidationException", onlyKey ? "The provided key element does not match the schema" : `One or more parameter values were invalid: Missing the key ${k.AttributeName} in the item`);
    }
    const want = t.attributeDefinitions.find((a) => a.AttributeName === k.AttributeName)!.AttributeType;
    const got = Object.keys(v)[0];
    if (want !== got) {
      throw c.error(
        "ValidationException",
        onlyKey ? "The provided key element does not match the schema" : `One or more parameter values were invalid: Type mismatch for key ${k.AttributeName} expected: ${want} actual: ${got}`,
      );
    }
  }
  if (onlyKey && Object.keys(item).length !== t.keySchema.length) throw c.error("ValidationException", "The provided key element does not match the schema");
}

const keyOf = (t: DdbTable, item: DdbItem) => JSON.stringify(t.keySchema.map((k) => item[k.AttributeName]));
const findItem = (t: DdbTable, key: DdbItem) => t.items.findIndex((i) => keyOf(t, i) === keyOf(t, key));

function describe(state: AwsState, t: DdbTable) {
  const size = t.items.reduce((n, i) => n + JSON.stringify(i).length, 0);
  return {
    AttributeDefinitions: t.attributeDefinitions,
    TableName: t.name,
    KeySchema: t.keySchema,
    TableStatus: status(state, t),
    CreationDateTime: iso(t.createdAt),
    ProvisionedThroughput: { NumberOfDecreasesToday: 0, ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
    TableSizeBytes: size,
    ItemCount: t.items.length,
    TableArn: t.arn,
    TableId: t.arn.slice(-36),
    BillingModeSummary: { BillingMode: t.billingMode },
    ...(t.gsis.length
      ? {
          GlobalSecondaryIndexes: t.gsis.map((g) => ({
            IndexName: g.IndexName,
            KeySchema: g.KeySchema,
            Projection: g.Projection,
            IndexStatus: status(state, t),
            IndexArn: `${t.arn}/index/${g.IndexName}`,
            ItemCount: t.items.filter((i) => g.KeySchema.every((k) => i[k.AttributeName])).length,
          })),
        }
      : {}),
    DeletionProtectionEnabled: false,
  };
}

function capacity(c: Call, t: DdbTable, bytes: number, write = false) {
  if (c.str("return-consumed-capacity") !== "TOTAL" && c.str("return-consumed-capacity") !== "INDEXES") return {};
  const units = write ? Math.max(1, Math.ceil(bytes / 1024)) : Math.max(0.5, Math.ceil(bytes / 4096) / 2);
  return { ConsumedCapacity: { TableName: t.name, CapacityUnits: units } };
}

function sortItems(items: DdbItem[], schema: DdbKeyElement[], forward: boolean): DdbItem[] {
  const range = schema.find((k) => k.KeyType === "RANGE")?.AttributeName;
  if (!range) return items;
  return [...items].sort((a, b) => {
    const r = a[range] && b[range] ? (compare(a[range], b[range]) ?? 0) : 0;
    return forward ? r : -r;
  });
}

function startAfter(c: Call, items: DdbItem[], schema: DdbKeyElement[], t: DdbTable): DdbItem[] {
  const start = c.structured("exclusive-start-key") as DdbItem | undefined;
  if (!start) return items;
  const keyNames = [...new Set([...t.keySchema, ...schema].map((k) => k.AttributeName))];
  const id = JSON.stringify(keyNames.map((k) => start[k]));
  const i = items.findIndex((x) => JSON.stringify(keyNames.map((k) => x[k])) === id);
  return i < 0 ? items : items.slice(i + 1);
}

function page(c: Call, t: DdbTable, items: DdbItem[], schema: DdbKeyElement[]): { items: DdbItem[]; last?: DdbItem } {
  const limit = c.int("limit");
  if (!limit || items.length <= limit) return { items };
  const slice = items.slice(0, limit);
  const lastItem = slice[slice.length - 1];
  const keyNames = [...new Set([...t.keySchema, ...schema].map((k) => k.AttributeName))];
  return { items: slice, last: Object.fromEntries(keyNames.map((k) => [k, lastItem[k]])) };
}

function finishRead(c: Call, t: DdbTable, scanned: DdbItem[], matched: DdbItem[], last: DdbItem | undefined, projection: string | undefined, ctx: ReturnType<typeof makeCtx>) {
  const paths = projection ? wrap(c, () => parseProjection(projection, ctx)) : null;
  wrap(c, () => checkUnused(ctx));
  const select = c.str("select");
  const bytes = scanned.reduce((n, i) => n + JSON.stringify(i).length, 0);
  return {
    ...(select === "COUNT" ? {} : { Items: matched.map((i) => (paths ? project(i, paths) : i)) }),
    Count: matched.length,
    ScannedCount: scanned.length,
    ...(last ? { LastEvaluatedKey: last } : {}),
    ...capacity(c, t, bytes),
  };
}

const dynamodb: Service = {
  blurb: "DynamoDB: a key-value and document database that scales without servers",
  commands: {
    "create-table": (c) => {
      const name = c.str("table-name", true);
      if (!/^[A-Za-z0-9_.-]{3,255}$/.test(name)) throw c.error("ValidationException", "TableName must be at least 3 characters long and at most 255 characters long, and contain only a-z, A-Z, 0-9, _, - and .");
      c.authorize("dynamodb:CreateTable", arn.ddb(name));
      if (c.state.dynamodb.tables[name]) throw c.error("ResourceInUseException", `Table already exists: ${name}`);
      const defs = c.structuredList("attribute-definitions", true) as { AttributeName: string; AttributeType: "S" | "N" | "B" }[];
      const keys = c.structuredList("key-schema", true) as unknown as DdbKeyElement[];
      const billing = c.str("billing-mode") ?? "PROVISIONED";
      if (billing === "PROVISIONED" && !c.has("provisioned-throughput")) {
        throw c.error("ValidationException", "One or more parameter values were invalid: ReadCapacityUnits and WriteCapacityUnits must both be specified when BillingMode is PROVISIONED (or use --billing-mode PAY_PER_REQUEST)");
      }
      if (!keys.some((k) => k.KeyType === "HASH")) throw c.error("ValidationException", "1 validation error detected: KeySchema must have a HASH key");
      const gsisRaw = c.structured("global-secondary-indexes");
      const gsis = (gsisRaw ? (Array.isArray(gsisRaw) ? gsisRaw : [gsisRaw]) : []) as DdbTable["gsis"];
      const used = new Set([...keys.map((k) => k.AttributeName), ...gsis.flatMap((g) => g.KeySchema.map((k) => k.AttributeName))]);
      for (const k of used) {
        if (!defs.some((d) => d.AttributeName === k)) throw c.error("ValidationException", `One or more parameter values were invalid: Some index key attributes are not defined in AttributeDefinitions. Keys: [${k}], AttributeDefinitions: [${defs.map((d) => d.AttributeName).join(", ")}]`);
      }
      for (const d of defs) {
        if (!used.has(d.AttributeName)) {
          throw c.error(
            "ValidationException",
            `One or more parameter values were invalid: Number of attributes in KeySchema does not exactly match number of attributes defined in AttributeDefinitions (only list attributes used in keys or indexes; DynamoDB tables have no fixed columns)`,
          );
        }
      }
      const t = now(c.state);
      const table: DdbTable = {
        name,
        arn: arn.ddb(name),
        createdAt: t,
        activeAt: t + 2500,
        keySchema: keys,
        attributeDefinitions: defs,
        gsis: gsis.map((g) => ({ IndexName: g.IndexName, KeySchema: g.KeySchema, Projection: g.Projection ?? { ProjectionType: "ALL" } })),
        billingMode: billing,
        items: [],
      };
      c.state.dynamodb.tables[name] = table;
      return { TableDescription: describe(c.state, table) };
    },
    "describe-table": (c) => {
      const t = needTable(c, c.str("table-name", true), "dynamodb:DescribeTable");
      return { Table: describe(c.state, t) };
    },
    "list-tables": (c) => {
      c.authorize("dynamodb:ListTables", "*");
      return { TableNames: Object.keys(c.state.dynamodb.tables).sort() };
    },
    "delete-table": (c) => {
      const t = needTable(c, c.str("table-name", true), "dynamodb:DeleteTable");
      delete c.state.dynamodb.tables[t.name];
      return { TableDescription: { ...describe(c.state, t), TableStatus: "DELETING" } };
    },
    wait: (c) => {
      const what = c.positionals[0];
      const name = c.str("table-name", true);
      if (what === "table-exists") {
        const t = needTable(c, name, "dynamodb:DescribeTable");
        const wait = t.activeAt - now(c.state);
        if (wait > 0) c.state.clockOffset += wait; // the waiter polls until ACTIVE; here time just jumps ahead
        return undefined;
      }
      if (what === "table-not-exists") return undefined;
      throw new UsageError("aws dynamodb wait: choose table-exists or table-not-exists");
    },
    "put-item": (c) => {
      const t = activeTable(c, c.str("table-name", true), "dynamodb:PutItem");
      const item = validateItem(c, c.structured("item", true));
      checkKey(c, t, item, false);
      const ctx = makeCtx(c.structured("expression-attribute-names") as Record<string, string>, c.structured("expression-attribute-values") as Record<string, DdbValue>, "ConditionExpression");
      const i = findItem(t, item);
      const cond = c.str("condition-expression");
      if (cond) {
        const parsed = wrap(c, () => parseCondition(cond, ctx));
        wrap(c, () => checkUnused(ctx));
        if (!evalCond(parsed, i >= 0 ? t.items[i] : {}, ctx)) throw c.error("ConditionalCheckFailedException", "The conditional request failed");
      } else wrap(c, () => checkUnused(ctx));
      const old = i >= 0 ? t.items[i] : undefined;
      if (i >= 0) t.items[i] = item;
      else t.items.push(item);
      return { ...(c.str("return-values") === "ALL_OLD" && old ? { Attributes: old } : {}), ...capacity(c, t, JSON.stringify(item).length, true) };
    },
    "get-item": (c) => {
      const t = activeTable(c, c.str("table-name", true), "dynamodb:GetItem");
      const key = validateItem(c, c.structured("key", true), "Key");
      checkKey(c, t, key, true);
      const ctx = makeCtx(c.structured("expression-attribute-names") as Record<string, string>, undefined, "ProjectionExpression");
      const proj = c.str("projection-expression");
      const paths = proj ? wrap(c, () => parseProjection(proj, ctx)) : null;
      wrap(c, () => checkUnused(ctx));
      const i = findItem(t, key);
      if (i < 0) return { ...capacity(c, t, 1) };
      return { Item: paths ? project(t.items[i], paths) : t.items[i], ...capacity(c, t, JSON.stringify(t.items[i]).length) };
    },
    "delete-item": (c) => {
      const t = activeTable(c, c.str("table-name", true), "dynamodb:DeleteItem");
      const key = validateItem(c, c.structured("key", true), "Key");
      checkKey(c, t, key, true);
      const i = findItem(t, key);
      const cond = c.str("condition-expression");
      const ctx = makeCtx(c.structured("expression-attribute-names") as Record<string, string>, c.structured("expression-attribute-values") as Record<string, DdbValue>, "ConditionExpression");
      if (cond) {
        const parsed = wrap(c, () => parseCondition(cond, ctx));
        if (!evalCond(parsed, i >= 0 ? t.items[i] : {}, ctx)) throw c.error("ConditionalCheckFailedException", "The conditional request failed");
      }
      wrap(c, () => checkUnused(ctx));
      const old = i >= 0 ? t.items.splice(i, 1)[0] : undefined;
      return c.str("return-values") === "ALL_OLD" && old ? { Attributes: old } : undefined;
    },
    "update-item": (c) => {
      const t = activeTable(c, c.str("table-name", true), "dynamodb:UpdateItem");
      const key = validateItem(c, c.structured("key", true), "Key");
      checkKey(c, t, key, true);
      const expr = c.str("update-expression", true);
      const ctx = makeCtx(c.structured("expression-attribute-names") as Record<string, string>, c.structured("expression-attribute-values") as Record<string, DdbValue>, "UpdateExpression");
      const actions = wrap(c, () => parseUpdate(expr, ctx));
      for (const a of actions) {
        if (t.keySchema.some((k) => k.AttributeName === a.path[0])) {
          throw c.error("ValidationException", `One or more parameter values were invalid: Cannot update attribute ${a.path[0]}. This attribute is part of the key`);
        }
      }
      const i = findItem(t, key);
      const before = i >= 0 ? t.items[i] : undefined;
      const cond = c.str("condition-expression");
      if (cond) {
        ctx.what = "ConditionExpression";
        const parsed = wrap(c, () => parseCondition(cond, ctx));
        if (!evalCond(parsed, before ?? {}, ctx)) {
          wrap(c, () => checkUnused(ctx));
          throw c.error("ConditionalCheckFailedException", "The conditional request failed");
        }
      }
      wrap(c, () => checkUnused(ctx));
      const item: DdbItem = JSON.parse(JSON.stringify(before ?? key));
      wrap(c, () => applyUpdate(item, actions, ctx));
      if (i >= 0) t.items[i] = item;
      else t.items.push(item);
      const rv = c.str("return-values") ?? "NONE";
      const changed = new Set(actions.map((a) => String(a.path[0])));
      const pick = (src: DdbItem | undefined) => Object.fromEntries(Object.entries(src ?? {}).filter(([k]) => changed.has(k)));
      const attrs = rv === "ALL_NEW" ? item : rv === "ALL_OLD" ? before : rv === "UPDATED_NEW" ? pick(item) : rv === "UPDATED_OLD" ? pick(before) : undefined;
      return { ...(attrs ? { Attributes: attrs } : {}), ...capacity(c, t, JSON.stringify(item).length, true) };
    },
    query: (c) => {
      const t = activeTable(c, c.str("table-name", true), "dynamodb:Query");
      const indexName = c.str("index-name");
      const gsi = indexName ? t.gsis.find((g) => g.IndexName === indexName) : undefined;
      if (indexName && !gsi) throw c.error("ValidationException", `The table does not have the specified index: ${indexName}`);
      const schema = gsi ? gsi.KeySchema : t.keySchema;
      const kce = c.str("key-condition-expression");
      if (!kce) throw c.error("ValidationException", "Either the KeyConditions or KeyConditionExpression parameter must be specified in the request.");
      const ctx = makeCtx(c.structured("expression-attribute-names") as Record<string, string>, c.structured("expression-attribute-values") as Record<string, DdbValue>, "KeyConditionExpression");
      const keyCond = wrap(c, () => parseCondition(kce, ctx));
      const parts = wrap(c, () => keyParts(keyCond));
      const hash = schema.find((k) => k.KeyType === "HASH")!.AttributeName;
      const range = schema.find((k) => k.KeyType === "RANGE")?.AttributeName;
      const hashPart = parts.find((p) => condAttr(p) === hash);
      if (!hashPart || hashPart.k !== "cmp" || hashPart.op !== "=") throw c.error("ValidationException", `Query condition missed key schema element: ${hash}`);
      for (const p of parts) {
        const a = condAttr(p);
        if (a !== hash && a !== range) throw c.error("ValidationException", `Query key condition not supported: ${a} is not part of the ${gsi ? "index" : "table"}'s key. Use --filter-expression for other attributes.`);
      }
      const filterSrc = c.str("filter-expression");
      ctx.what = "FilterExpression";
      const filter = filterSrc ? wrap(c, () => parseCondition(filterSrc, ctx)) : null;
      ctx.what = "ProjectionExpression";
      const base = t.items.filter((i) => schema.every((k) => i[k.AttributeName]));
      const forward = !c.bool("no-scan-index-forward");
      let keyed = sortItems(base.filter((i) => parts.every((p) => evalCond(p, i, ctx))), schema, forward);
      keyed = startAfter(c, keyed, schema, t);
      const { items: pageItems, last } = page(c, t, keyed, schema);
      const matched = filter ? pageItems.filter((i) => evalCond(filter, i, ctx)) : pageItems;
      return finishRead(c, t, pageItems, matched, last, c.str("projection-expression"), ctx);
    },
    scan: (c) => {
      const t = activeTable(c, c.str("table-name", true), "dynamodb:Scan");
      const ctx = makeCtx(c.structured("expression-attribute-names") as Record<string, string>, c.structured("expression-attribute-values") as Record<string, DdbValue>, "FilterExpression");
      const filterSrc = c.str("filter-expression");
      const filter = filterSrc ? wrap(c, () => parseCondition(filterSrc, ctx)) : null;
      ctx.what = "ProjectionExpression";
      let all = startAfter(c, t.items, t.keySchema, t);
      const { items: pageItems, last } = page(c, t, all, t.keySchema);
      all = pageItems;
      const matched = filter ? all.filter((i) => evalCond(filter, i, ctx)) : all;
      return finishRead(c, t, all, matched, last, c.str("projection-expression"), ctx);
    },
    "batch-write-item": (c) => {
      const req = c.structured("request-items", true) as Record<string, { PutRequest?: { Item: DdbItem }; DeleteRequest?: { Key: DdbItem } }[]>;
      for (const [name, ops] of Object.entries(req)) {
        const t = activeTable(c, name, "dynamodb:BatchWriteItem");
        if (ops.length > 25) throw c.error("ValidationException", "Too many items requested for the BatchWriteItem call (25 at most)");
        for (const op of ops) {
          if (op.PutRequest) {
            const item = validateItem(c, op.PutRequest.Item);
            checkKey(c, t, item, false);
            const i = findItem(t, item);
            if (i >= 0) t.items[i] = item;
            else t.items.push(item);
          } else if (op.DeleteRequest) {
            const i = findItem(t, op.DeleteRequest.Key);
            if (i >= 0) t.items.splice(i, 1);
          }
        }
      }
      return { UnprocessedItems: {} };
    },
  },
};

export const DYNAMODB_SERVICES = { dynamodb };

/* ------------------------------------------------------------------ */
/* Plain JSON <-> DynamoDB typed values, for the SDK inside Lambda      */
/* ------------------------------------------------------------------ */

export function marshall(v: unknown): DdbValue {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === "string") return { S: v };
  if (typeof v === "number") return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(marshall) };
  if (v instanceof Set) {
    const arr = [...v];
    return arr.every((x) => typeof x === "number") ? { NS: arr.map(String) } : { SS: arr.map(String) };
  }
  if (typeof v === "object") return { M: Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== undefined).map(([k, x]) => [k, marshall(x)])) };
  return { S: String(v) };
}

export function unmarshall(v: DdbValue): unknown {
  const t = Object.keys(v)[0];
  const x = v[t];
  switch (t) {
    case "S":
    case "B":
      return x;
    case "N":
      return Number(x);
    case "BOOL":
      return x;
    case "NULL":
      return null;
    case "L":
      return (x as DdbValue[]).map(unmarshall);
    case "M":
      return Object.fromEntries(Object.entries(x as Record<string, DdbValue>).map(([k, y]) => [k, unmarshall(y)]));
    case "SS":
      return new Set(x as string[]);
    case "NS":
      return new Set((x as string[]).map(Number));
    default:
      return x;
  }
}

export const marshallItem = (o: Record<string, unknown>): DdbItem => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined).map(([k, x]) => [k, marshall(x)]));
export const unmarshallItem = (i: DdbItem): Record<string, unknown> => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, unmarshall(v)]));
