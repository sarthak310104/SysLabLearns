import { notFound } from "next/navigation";
import { InterviewShell } from "@/components/interview/InterviewShell";
import { INTERVIEWS, interviewBySlug } from "@/content/interviews";

export function generateStaticParams() {
  return INTERVIEWS.map((i) => ({ slug: i.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const iv = interviewBySlug(slug);
  return { title: iv ? `${iv.title} | Interview | SysLabLearns` : "SysLabLearns" };
}

export default async function InterviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!interviewBySlug(slug)) notFound();
  return <InterviewShell slug={slug} />;
}
