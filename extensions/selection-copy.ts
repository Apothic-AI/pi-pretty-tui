/**
 * Clamp a fullscreen selection to content, so copying inside a framed block
 * yields text rather than the frame drawn around it.
 *
 * Pi's copy path (`TuiAltScreen#getActiveSelectionText`) walks the selected
 * screen rows and slices each one by column. Frames drawn by this extension are
 * ordinary buffer characters, so the frame lands in the clipboard unless the
 * copy knows which columns and rows are chrome.
 *
 * The seam is the layout frame: every component Pi lays out has a box with a
 * screen rect, so a selected screen row maps back to the component that drew it,
 * and that component's registered chrome says what to drop. Rows of components
 * without chrome copy exactly as before.
 */
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// Pi's layout types are internal modules that the host's module mapping does not
// resolve, so the shapes this file needs are declared here and the tree is
// walked structurally. A box is what `TuiAltScreen#currentLayout` holds.
type LayoutRect = { x: number; y: number; width: number; height: number };
type LayoutBox = {
  component: any; rect: LayoutRect; clip: LayoutRect; children: LayoutBox[];
  parent?: LayoutBox; scrollView?: { scrollTop?: number }; scrollContentLines?: readonly string[];
};
type LayoutFrame = { root: LayoutBox; width: number; height: number; lines: string[] };
import { selectionChromeOf, type RowChrome } from "./selection-chrome.js";

type SelectionPoint = { row: number; col: number; scrollView?: unknown; boundary?: boolean };
type SelectionBounds = { start: SelectionPoint; end: SelectionPoint };

export type CopyHost = {
  previousScreen?: string[];
  currentLayout?: LayoutFrame;
  terminal?: { rows: number; columns: number };
  getSelectionBounds?: () => SelectionBounds | undefined;
  getSelectionColumns?: (
    line: string, row: number, selection: SelectionBounds, minColumn?: number, maxColumn?: number,
  ) => { start: number; end: number };
};

/** The laid-out box that owns a scroll view, found structurally. */
export const scrollViewBox = (layout: LayoutFrame | undefined, scrollView: unknown): LayoutBox | undefined => {
  if (!layout) return undefined;
  const visit = (box: LayoutBox | undefined): LayoutBox | undefined => {
    if (!box) return undefined;
    if (box.scrollView === scrollView) return box;
    for (const child of box.children ?? []) {
      const match = visit(child);
      if (match) return match;
    }
    return undefined;
  };
  return visit(layout.root);
};

/** Deepest laid-out box whose screen rect contains a row. */
export const boxAtRow = (box: LayoutBox | undefined, y: number): LayoutBox | undefined => {
  if (!box || y < box.rect.y || y >= box.rect.y + box.rect.height) return undefined;
  for (const child of box.children) {
    const match = boxAtRow(child, y);
    if (match) return match;
  }
  return box;
};

/**
 * Chrome for a screen row. Chrome is registered against the component Pi draws,
 * so this resolves the component first and then asks it about the row.
 */
const chromeAtScreenRow = (host: CopyHost, screenRow: number): RowChrome | undefined => {
  const layout = host.currentLayout;
  if (!layout) return undefined;
  const box = boxAtRow(layout.root, screenRow);
  if (!box) return undefined;
  // Walk up: a wrapper whose children are plain rectangles can still own chrome.
  for (let current: LayoutBox | undefined = box; current; current = current.parent) {
    const chrome = selectionChromeOf(current.component);
    const value = chrome?.(screenRow - current.rect.y);
    if (value) return value;
  }
  return undefined;
};

/**
 * Screen row that draws a given content row, or undefined when scrolled away.
 * A content row has no rect of its own, so the viewport maps it.
 */
const contentRowScreenRow = (host: CopyHost, contentRow: number, scrollView: unknown): number | undefined => {
  const layout = host.currentLayout;
  if (!layout) return undefined;
  const view = scrollViewBox(layout, scrollView);
  if (!view) return undefined;
  const scrollTop = (view.scrollView as any)?.scrollTop ?? 0;
  const screenRow = view.rect.y + contentRow - scrollTop;
  const top = Math.max(view.rect.y, view.clip.y);
  const bottom = Math.min(view.rect.y + view.rect.height, view.clip.y + view.clip.height);
  return screenRow >= top && screenRow < bottom ? screenRow : undefined;
};

const rowChrome = (
  host: CopyHost, row: number, scrollView: unknown,
): RowChrome | undefined => {
  // A content row is drawn at a screen row; a transcript row already is one.
  const screenRow = scrollView ? contentRowScreenRow(host, row, scrollView) : row;
  if (screenRow === undefined) return undefined;
  return chromeAtScreenRow(host, screenRow);
};

/**
 * Rebuild copied text the way Pi does, clamped to registered chrome.
 *
 * `applied` says whether this extension had chrome to contribute on any
 * selected row. When it did not, the caller must keep Pi's own result: a
 * selection over plain transcript text has to behave exactly as before. When it
 * did, `text` is authoritative even if it is empty — a selection that covered
 * nothing but frame rules copies nothing, rather than falling back to the
 * frame-bearing text this exists to remove.
 */
export type SelectionCopy = { applied: boolean; text?: string };

export const selectionText = (host: CopyHost): SelectionCopy => {
  const selection = host.getSelectionBounds?.();
  const getColumns = host.getSelectionColumns;
  if (!selection || !getColumns) return { applied: false };
  let sourceLines: readonly string[] = host.previousScreen ?? [];
  let scrollView: unknown;
  if (selection.start.scrollView) {
    const box = host.currentLayout ? scrollViewBox(host.currentLayout, selection.start.scrollView) : undefined;
    if (!box?.scrollContentLines) return { applied: false };
    sourceLines = box.scrollContentLines;
    scrollView = selection.start.scrollView;
  }
  const lines: string[] = [];
  let applied = false;
  for (let row = selection.start.row; row <= selection.end.row; row++) {
    const line = sourceLines[row] ?? "";
    const columns = getColumns.call(host, line, row, selection);
    const chrome = rowChrome(host, row, scrollView);
    if (chrome === "frame") {
      applied = true;
      continue;
    }
    if (chrome) {
      applied = true;
      const width = visibleWidth(line);
      columns.start = Math.max(columns.start, chrome.left);
      columns.end = Math.min(columns.end, Math.max(0, width - chrome.right));
      if (columns.end <= columns.start) continue;
    }
    lines.push(stripTerminalSequences(
      sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
    ).trimEnd());
  }
  if (!applied) return { applied: false };
  return { applied: true, text: lines.join("\n") };
};
