import type { ThreadView } from "./api.ts";

/** A selection mapped to raw source offsets; rect is in viewport coordinates. */
export interface Selection {
  start: number;
  end: number;
  text: string;
  rect: { left: number; top: number; right: number; bottom: number };
}

export interface DocCallbacks {
  onSelect(sel: Selection | null): void;
  /** a click landed on these threads' anchors (innermost first) */
  onActivate(ids: string[]): void;
  /** geometry changed: thread cards need re-layout */
  onLayout(): void;
  /** the selection could not be mapped to the source */
  onUnmappable?(): void;
}

export interface DocView {
  setContent(content: string): void;
  setThreads(threads: ThreadView[], active: string | null): void;
  /** px from the host's top to the anchor's first line, null when not shown */
  anchorTop(t: ThreadView): number | null;
  clearSelection(): void;
  destroy(): void;
}
