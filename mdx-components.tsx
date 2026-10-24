import type { MDXComponents } from "mdx/types";
import { Goals } from "@/components/lesson/Goals";
import { Note } from "@/components/lesson/Note";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return { ...components, Goals, Note };
}
