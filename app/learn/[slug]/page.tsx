import { notFound } from "next/navigation";
import type { ComponentType } from "react";
import { LessonShell } from "@/components/lesson/LessonShell";
import { LESSONS, lessonBySlug } from "@/content/curriculum";

// One loader per lesson keeps the imports static, which every bundler handles.
const CONTENT: Record<string, () => Promise<{ default: ComponentType }>> = {
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
};

export function generateStaticParams() {
  return LESSONS.map((l) => ({ slug: l.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = lessonBySlug(slug);
  return { title: found ? `${found.lesson.code} ${found.lesson.title} | SysLabLearns` : "SysLabLearns" };
}

export default async function LessonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const load = CONTENT[slug];
  if (!load || !lessonBySlug(slug)) notFound();
  const { default: Content } = await load();
  return (
    <LessonShell slug={slug}>
      <Content />
    </LessonShell>
  );
}
