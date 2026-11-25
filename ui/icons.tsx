// Small inline SVG icon set (stroke icons on a 24px grid).
// Paths from Lucide (https://lucide.dev), ISC License, Copyright (c) Lucide Contributors 2022,
// portions Copyright (c) Cole Bemis 2013-2022 (Feather, MIT). Full text: THIRD_PARTY_NOTICES.md

import type { JSX } from "preact";

type P = { size?: number; class?: string; title?: string };

function svg(paths: JSX.Element, { size = 16, class: cls, title }: P) {
  return (
    <svg class={`icon ${cls ?? ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden={title ? undefined : "true"}>
      {title && <title>{title}</title>}
      {paths}
    </svg>
  );
}

export const IconMessage = (p: P) => svg(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />, p);
export const IconPlay = (p: P) => svg(<polygon points="6 4 20 12 6 20 6 4" />, p);
export const IconHelp = (p: P) =>
  svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>,
    p,
  );
export const IconCheck = (p: P) => svg(<polyline points="20 6 9 17 4 12" />, p);
export const IconX = (p: P) =>
  svg(
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>,
    p,
  );
export const IconRotate = (p: P) =>
  svg(
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </>,
    p,
  );
export const IconSmilePlus = (p: P) =>
  svg(
    <>
      <path d="M22 11v1a10 10 0 1 1-9-10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <path d="M9 9h.01" />
      <path d="M15 9h.01" />
      <path d="M16 5h6" />
      <path d="M19 2v6" />
    </>,
    p,
  );
export const IconFile = (p: P) =>
  svg(
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>,
    p,
  );
export const IconFileCode = (p: P) =>
  svg(
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="m10 13-2 2 2 2" />
      <path d="m14 17 2-2-2-2" />
    </>,
    p,
  );
export const IconFileText = (p: P) =>
  svg(
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
      <path d="M10 9H8" />
    </>,
    p,
  );
export const IconFolder = (p: P) => svg(<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />, p);
export const IconChevron = (p: P) => svg(<path d="m9 18 6-6-6-6" />, p);
export const IconSun = (p: P) =>
  svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
    </>,
    p,
  );
export const IconMoon = (p: P) => svg(<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />, p);
export const IconBot = (p: P) =>
  svg(
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </>,
    p,
  );
export const IconUnlink = (p: P) =>
  svg(
    <>
      <path d="m18.8 13.4 1.4-1.4a5 5 0 0 0-7.1-7.1l-1.4 1.4" />
      <path d="m5.2 10.6-1.4 1.4a5 5 0 0 0 7.1 7.1l1.4-1.4" />
      <path d="m8 2v3M2 8h3M16 22v-3M22 16h-3" />
    </>,
    p,
  );
export const IconCrosshair = (p: P) =>
  svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M22 12h-4M6 12H2M12 6V2M12 22v-4" />
    </>,
    p,
  );
export const IconSidebar = (p: P) =>
  svg(
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </>,
    p,
  );
export const IconPanelRight = (p: P) =>
  svg(
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </>,
    p,
  );
export const IconPencil = (p: P) => svg(<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />, p);
export const IconTrash = (p: P) =>
  svg(
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>,
    p,
  );
export const IconHand = (p: P) =>
  svg(
    <>
      <path d="M18 11V6a2 2 0 0 0-4 0v5" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3.4 16a2 2 0 0 1 3-2.6L8 15" />
    </>,
    p,
  );
export const IconEye = (p: P) =>
  svg(
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>,
    p,
  );
export const IconThumb = (p: P) =>
  svg(
    <>
      <path d="M7 10v12" />
      <path d="M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.4 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z" />
    </>,
    p,
  );
export const IconDots = (p: P) =>
  svg(
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>,
    p,
  );
export const IconDiff = (p: P) =>
  svg(
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M9 10h6" />
      <path d="M12 13V7" />
      <path d="M9 17h6" />
    </>,
    p,
  );
