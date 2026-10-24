import { describe, expect, it } from "vitest";
import { lab } from "./helpers";

describe("S3", () => {
  it("makes buckets, uploads, lists and downloads", async () => {
    const { run } = lab();
    expect((await run("aws s3 mb s3://sarthak-notes-2026")).out).toBe("make_bucket: sarthak-notes-2026\n");
    expect((await run("aws s3 cp hello.txt s3://sarthak-notes-2026/")).out).toBe("upload: ./hello.txt to s3://sarthak-notes-2026/hello.txt\n");
    await run('echo "a photo" > cat.jpg && aws s3 cp cat.jpg s3://sarthak-notes-2026/photos/cat.jpg');
    const ls = (await run("aws s3 ls s3://sarthak-notes-2026")).out;
    expect(ls).toMatch(/PRE photos\//);
    expect(ls).toMatch(/\s22 hello\.txt/);
    expect((await run("aws s3 ls")).out).toMatch(/sarthak-notes-2026/);
    expect((await run("aws s3 cp s3://sarthak-notes-2026/hello.txt copy.txt")).out).toMatch(/download:/);
    expect((await run("cat copy.txt")).out).toBe("Hello from my laptop!\n");
  });

  it("teaches the real gotchas", async () => {
    const { run } = lab();
    expect((await run("aws s3 mb s3://test")).err).toMatch(/BucketAlreadyExists/);
    expect((await run("aws s3 mb s3://Bad_Name")).err).toMatch(/InvalidBucketName/);
    const r = await run("aws s3api create-bucket --bucket sarthak-raw-1");
    expect(r.err).toMatch(/IllegalLocationConstraintException/);
    expect(r.code).toBe(254);
    const ok = await run("aws s3api create-bucket --bucket sarthak-raw-1 --create-bucket-configuration LocationConstraint=ap-south-1");
    expect(ok.json().Location).toContain("sarthak-raw-1");
    await run("aws s3 cp hello.txt s3://sarthak-raw-1/");
    expect((await run("aws s3 rb s3://sarthak-raw-1")).err).toMatch(/BucketNotEmpty/);
    expect((await run("aws s3 rb s3://sarthak-raw-1 --force")).out).toMatch(/remove_bucket: sarthak-raw-1/);
  });

  it("blocks public access by default, and presigned URLs work and expire", async () => {
    const { run } = lab();
    await run("aws s3 mb s3://sarthak-share && aws s3 cp hello.txt s3://sarthak-share/hello.txt");
    expect((await run("curl https://sarthak-share.s3.ap-south-1.amazonaws.com/hello.txt")).out).toMatch(/AccessDenied/);
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::sarthak-share/*" }] });
    await run(`echo '${policy}' > policy.json`);
    expect((await run("aws s3api put-bucket-policy --bucket sarthak-share --policy file://policy.json")).err).toMatch(/BlockPublicPolicy/);

    const url = (await run("aws s3 presign s3://sarthak-share/hello.txt --expires-in 60")).out.trim();
    expect((await run(`curl "${url}"`)).out).toBe("Hello from my laptop!\n");
    await run("sleep 61");
    expect((await run(`curl "${url}"`)).out).toMatch(/Request has expired/);

    await run("aws s3api delete-public-access-block --bucket sarthak-share");
    expect((await run("aws s3api put-bucket-policy --bucket sarthak-share --policy file://policy.json")).code).toBe(0);
    expect((await run("curl https://sarthak-share.s3.ap-south-1.amazonaws.com/hello.txt")).out).toBe("Hello from my laptop!\n");
  });

  it("keeps old versions when versioning is on", async () => {
    const { run } = lab();
    await run("aws s3 mb s3://sarthak-ver");
    await run("aws s3api put-bucket-versioning --bucket sarthak-ver --versioning-configuration Status=Enabled");
    await run("echo v1 > n.txt && aws s3 cp n.txt s3://sarthak-ver/n.txt && echo v2 > n.txt && aws s3 cp n.txt s3://sarthak-ver/n.txt");
    const v = (await run("aws s3api list-object-versions --bucket sarthak-ver")).json();
    expect(v.Versions).toHaveLength(2);
    const old = v.Versions.find((x: { IsLatest: boolean }) => !x.IsLatest).VersionId;
    await run(`aws s3api get-object --bucket sarthak-ver --key n.txt --version-id ${old} back.txt`);
    expect((await run("cat back.txt")).out).toBe("v1\n");
  });

  it("supports --query, --output text and shell variables", async () => {
    const { run } = lab();
    await run("aws s3 mb s3://sarthak-q1 && aws s3 mb s3://sarthak-q2");
    expect((await run("aws s3api list-buckets --query 'Buckets[].Name' --output text")).out).toBe("sarthak-q1\tsarthak-q2\n");
    await run("B=$(aws s3api list-buckets --query 'Buckets[0].Name' --output text)");
    expect((await run("echo $B")).out).toBe("sarthak-q1\n");
    expect((await run("aws s3api list-buckets --query \"Buckets[?Name=='sarthak-q2'].Name | [0]\" --output text")).out).toBe("sarthak-q2\n");
  });
});
