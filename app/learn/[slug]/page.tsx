import { notFound } from "next/navigation";
import type { ComponentType } from "react";
import { LessonShell } from "@/components/lesson/LessonShell";
import { AwsShell } from "@/components/aws/AwsShell";
import { ProtocolShell } from "@/components/protocol/ProtocolShell";
import { AWS_LESSONS, awsLessonBySlug, LESSONS, lessonBySlug, PROTOCOL_LESSONS, protocolLessonBySlug } from "@/content/curriculum";

// One loader per lesson keeps the imports static, which every bundler handles.
const CONTENT: Record<string, () => Promise<{ default: ComponentType }>> = {
  "a0-foundations": () => import("@/content/system-design/a0-foundations.mdx"),
  "a1-requests": () => import("@/content/system-design/a1-requests.mdx"),
  "a2-load-balancing": () => import("@/content/system-design/a2-load-balancing.mdx"),
  "a3-caching": () => import("@/content/system-design/a3-caching.mdx"),
  "a4-replication": () => import("@/content/system-design/a4-replication.mdx"),
  "a5-sharding": () => import("@/content/system-design/a5-sharding.mdx"),
  "a6-queues": () => import("@/content/system-design/a6-queues.mdx"),
  "a7-resilience": () => import("@/content/system-design/a7-resilience.mdx"),
  "a8-partitions": () => import("@/content/system-design/a8-partitions.mdx"),
  "a9-cdn": () => import("@/content/system-design/a9-cdn.mdx"),
  "a10-consistent-hashing": () => import("@/content/system-design/a10-consistent-hashing.mdx"),
  "a11-rate-limiting": () => import("@/content/system-design/a11-rate-limiting.mdx"),
  "a12-autoscaling": () => import("@/content/system-design/a12-autoscaling.mdx"),
  "b0-foundations": () => import("@/content/protocols/b0-foundations.mdx"),
  "b1-clocks": () => import("@/content/protocols/b1-clocks.mdx"),
  "b2-rpc": () => import("@/content/protocols/b2-rpc.mdx"),
  "b3-primary-backup": () => import("@/content/protocols/b3-primary-backup.mdx"),
  "b4-paxos": () => import("@/content/protocols/b4-paxos.mdx"),
  "b5-raft": () => import("@/content/protocols/b5-raft.mdx"),
  "b6-shardkv": () => import("@/content/protocols/b6-shardkv.mdx"),
  "b7-2pc": () => import("@/content/protocols/b7-2pc.mdx"),
  "b8-crdt": () => import("@/content/protocols/b8-crdt.mdx"),
  "c1-cloud-basics": () => import("@/content/aws/c1-cloud-basics.mdx"),
  "c2-s3": () => import("@/content/aws/c2-s3.mdx"),
  "c3-iam": () => import("@/content/aws/c3-iam.mdx"),
  "c4-sqs": () => import("@/content/aws/c4-sqs.mdx"),
  "c5-sns": () => import("@/content/aws/c5-sns.mdx"),
  "c6-dynamodb": () => import("@/content/aws/c6-dynamodb.mdx"),
  "c7-lambda": () => import("@/content/aws/c7-lambda.mdx"),
  "c8-serverless-api": () => import("@/content/aws/c8-serverless-api.mdx"),
  "c9-websites": () => import("@/content/aws/c9-websites.mdx"),
  "c10-eventbridge": () => import("@/content/aws/c10-eventbridge.mdx"),
  "c11-step-functions": () => import("@/content/aws/c11-step-functions.mdx"),
  "c12-mystery": () => import("@/content/aws/c12-mystery.mdx"),
};

export function generateStaticParams() {
  return [...LESSONS, ...PROTOCOL_LESSONS, ...AWS_LESSONS].map((l) => ({ slug: l.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = lessonBySlug(slug) ?? protocolLessonBySlug(slug) ?? awsLessonBySlug(slug);
  return { title: found ? `${found.lesson.code} ${found.lesson.title} | SysLabLearns` : "SysLabLearns" };
}

export default async function LessonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const load = CONTENT[slug];
  if (!load || !(lessonBySlug(slug) || protocolLessonBySlug(slug) || awsLessonBySlug(slug))) notFound();
  const { default: Content } = await load();
  if (awsLessonBySlug(slug)) {
    return (
      <AwsShell slug={slug}>
        <Content />
      </AwsShell>
    );
  }
  if (protocolLessonBySlug(slug)) {
    return (
      <ProtocolShell slug={slug}>
        <Content />
      </ProtocolShell>
    );
  }
  return (
    <LessonShell slug={slug}>
      <Content />
    </LessonShell>
  );
}
