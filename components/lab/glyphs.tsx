import type { ComponentKind } from "@/engine/model/types";

/** Small, original line glyphs for each component kind. */
export function Glyph({ kind, size = 18 }: { kind: ComponentKind; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "client":
      return (
        <svg {...common}>
          <circle cx="5" cy="6" r="2" />
          <circle cx="5" cy="14" r="2" />
          <path d="M9 6h7M9 14h7M14 4l2 2-2 2M14 12l2 2-2 2" />
        </svg>
      );
    case "loadBalancer":
      return (
        <svg {...common}>
          <circle cx="4" cy="10" r="2" />
          <path d="M6 10h3M9 10l7-6M9 10h7M9 10l7 6" />
        </svg>
      );
    case "server":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="14" height="6" rx="1.5" />
          <rect x="3" y="11" width="14" height="6" rx="1.5" />
          <path d="M6 6h.01M6 14h.01" strokeWidth="2.4" />
        </svg>
      );
    case "cache":
      return (
        <svg {...common}>
          <path d="M11 2 4 11h5l-1 7 7-9h-5l1-7Z" />
        </svg>
      );
    case "database":
      return (
        <svg {...common}>
          <ellipse cx="10" cy="5" rx="6" ry="2.5" />
          <path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" />
        </svg>
      );
    case "replica":
      return (
        <svg {...common}>
          <ellipse cx="10" cy="5" rx="6" ry="2.5" strokeDasharray="2 2" />
          <path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5" strokeDasharray="2 2" />
          <path d="M8 11l2 2 2-2" />
        </svg>
      );
    case "queue":
      return (
        <svg {...common}>
          <rect x="2.5" y="6" width="4" height="8" rx="1" />
          <rect x="8" y="6" width="4" height="8" rx="1" />
          <rect x="13.5" y="6" width="4" height="8" rx="1" />
        </svg>
      );
  }
}
