import { notFound } from "next/navigation";
import { ChallengeShell } from "@/components/challenge/ChallengeShell";
import { CHALLENGES, challengeBySlug } from "@/content/challenges";

export function generateStaticParams() {
  return CHALLENGES.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ch = challengeBySlug(slug);
  return { title: ch ? `${ch.code} ${ch.title} | SysLabLearns` : "SysLabLearns" };
}

export default async function ChallengePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!challengeBySlug(slug)) notFound();
  return <ChallengeShell slug={slug} />;
}
