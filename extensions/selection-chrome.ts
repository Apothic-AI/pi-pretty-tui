/**
 * Copying a selection must yield content, not the frame drawn around it.
 *
 * Pi builds copied text from the rendered screen buffer: `TuiAltScreen` walks
 * the selected rows, slices each by column, strips escape sequences, and joins
 * with newlines. Border glyphs are ordinary buffer characters, so a selection
 * that crosses a framed card copies `│ … │` gutters, and one that reaches a
 * card's first or last row copies the `╭…╮` / `╰…╯` rule itself.
 *
 * Pi's copy path has no seam for a renderer to declare its chrome, so this
 * extension records the geometry it already computes while rendering:
 *
 * - a row that is pure frame (a rule, or a section divider);
 * - how many columns of a row are chrome on each side.
 *
 * Geometry is registered against the component Pi lays out, so the copy path
 * resolves a screen row to the component that drew it and clamps only there. A
 * `│` that is genuinely content — a Markdown table inside a message — sits
 * inside the clamp and survives.
 */

/** What one rendered row contributes to a copy. */
export type RowChrome =
  /** Chrome only: copying skips the row. */
  | "frame"
  /** Content between `left` and `width - right`; those columns are chrome. */
  | { left: number; right: number };

export type SelectionChrome = (rowIndex: number) => RowChrome | undefined;

const registry = new WeakMap<object, SelectionChrome>();

/** Record the chrome of a component's rendered rows. */
export const registerSelectionChrome = (component: object, chrome: SelectionChrome): void => {
  registry.set(component, chrome);
};

export const selectionChromeOf = (component: object | undefined): SelectionChrome | undefined =>
  component ? registry.get(component) : undefined;

/** Chrome rows for a frame: its rules are chrome, its body rows are inset. */
export const frameChrome = (
  rows: number, frames: ReadonlySet<number>, inset: number,
): SelectionChrome => (rowIndex) => {
  if (rowIndex < 0 || rowIndex >= rows) return undefined;
  return frames.has(rowIndex) ? "frame" : { left: inset, right: inset };
};

/**
 * Chrome for a component that stacks several rendered chunks: `spans` lists the
 * number of rows each chunk contributed, in order, with the chrome to use for
 * it. Rows past the last span are free content.
 */
export const stackedChrome = (
  spans: readonly { rows: number; chrome?: SelectionChrome }[],
): SelectionChrome => {
  const starts: number[] = [];
  let total = 0;
  for (const span of spans) {
    starts.push(total);
    total += span.rows;
  }
  return (rowIndex) => {
    if (rowIndex < 0) return undefined;
    for (let i = spans.length - 1; i >= 0; i--) {
      if (rowIndex >= starts[i]) {
        const row = rowIndex - starts[i];
        return row < spans[i].rows ? spans[i].chrome?.(row) : undefined;
      }
    }
    return undefined;
  };
};

/** Row indices of the rules a frame renderer produced. */
export const ruleRows = (lineCount: number, dividers: Iterable<number>): Set<number> => {
  const rows = new Set<number>(dividers);
  if (lineCount > 0) rows.add(0);
  if (lineCount > 1) rows.add(lineCount - 1);
  return rows;
};

/**
 * Chrome for a component whose rendered rows are one frame. `offset` covers
 * renderers that prepend rows before the frame.
 */
export const chromeFromFrame = (
  frame: { frameRows: ReadonlySet<number>; inset: number; lines: readonly string[] }, offset = 0,
): SelectionChrome => (rowIndex) => {
  const y = rowIndex - offset;
  if (y < 0 || y >= frame.lines.length) return undefined;
  return frame.frameRows.has(y) ? "frame" : { left: frame.inset, right: frame.inset };
};
