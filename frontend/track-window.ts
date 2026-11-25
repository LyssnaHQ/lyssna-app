import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Lists longer than this render only the rows near the viewport. */
export const WINDOW_MIN_ROWS = 200;
const OVERSCAN = 24;
const BLOCK = 8;

/**
 * Rows to render for a scroll position, padded by OVERSCAN rows and rounded
 * to blocks of BLOCK so small scrolls do not re-render the list.
 */
export function rowRange(
  scrollTop: number,
  viewport: number,
  listTop: number,
  rowHeight: number,
  count: number,
): [number, number] {
  if (count <= 0) return [0, 0];
  if (
    ![scrollTop, viewport, listTop, rowHeight].every(Number.isFinite) ||
    viewport <= 0 ||
    rowHeight <= 0
  )
    return [0, Math.min(count, 64)];
  const first = Math.floor((scrollTop - listTop) / rowHeight) - OVERSCAN;
  const last =
    Math.ceil((scrollTop + viewport - listTop) / rowHeight) + OVERSCAN;
  // Past the end, keep the last rows rendered rather than none.
  const lastStart =
    Math.floor(Math.max(0, count - 2 * OVERSCAN) / BLOCK) * BLOCK;
  const start = Math.min(
    lastStart,
    Math.max(0, Math.floor(first / BLOCK) * BLOCK),
  );
  const end = Math.min(
    count,
    Math.max(start + BLOCK, Math.ceil(last / BLOCK) * BLOCK),
  );
  return [start, end];
}

/**
 * Long song lists keep every song loaded but render only the visible rows:
 * 800 rendered rows held about 600 MB in the WebView. Returns the rows to
 * render and the row height for the spacers around them.
 */
/** Where the first row sits in the scroller's content, below the header. */
export function rowsTop(scroll: HTMLElement, list: HTMLElement) {
  const head = list.querySelector<HTMLElement>(".track-table-head");
  return (
    list.getBoundingClientRect().top -
    scroll.getBoundingClientRect().top +
    scroll.scrollTop +
    (head
      ? head.offsetHeight +
        (parseFloat(getComputedStyle(head).marginBottom) || 0)
      : 0)
  );
}

// The page's sticky bar covers the top of the scroller once shown.
const covered = (scroll: HTMLElement) =>
  scroll.querySelector<HTMLElement>(".artist-sticky.shown")?.offsetHeight ?? 0;

/**
 * How many rows sit above the visible top of the scroller, fractionally, so
 * a change of row height can scroll back to the same song.
 */
export function rowsScrolled(scroll: HTMLElement, list: HTMLElement) {
  const height = list.querySelector<HTMLElement>(".track-row")?.offsetHeight;
  if (!height) return 0;
  const top = scroll.scrollTop + covered(scroll);
  return Math.max(0, (top - rowsTop(scroll, list)) / height);
}

export function scrollToRows(
  scroll: HTMLElement,
  list: HTMLElement,
  rows: number,
) {
  const height = list.querySelector<HTMLElement>(".track-row")?.offsetHeight;
  if (!height || rows <= 0) return;
  scroll.scrollTop = rowsTop(scroll, list) + rows * height - covered(scroll);
}

export function useRowWindow(
  scroller: RefObject<HTMLDivElement | null>,
  table: RefObject<HTMLDivElement | null>,
  count: number,
  view: string,
) {
  const windowed = count > WINDOW_MIN_ROWS;
  const rowHeight = useRef(56);
  const [range, setRange] = useState<[number, number]>([0, 64]);
  useLayoutEffect(() => {
    const scroll = scroller.current;
    const list = table.current;
    if (!windowed || !scroll || !list) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (!scroll.isConnected || !list.isConnected) return;
      rowHeight.current =
        list.querySelector<HTMLElement>(".track-row")?.offsetHeight ||
        rowHeight.current;
      const next = rowRange(
        scroll.scrollTop,
        scroll.clientHeight,
        rowsTop(scroll, list),
        rowHeight.current,
        count,
      );
      setRange((current) =>
        current[0] === next[0] && current[1] === next[1] ? current : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroll.addEventListener("scroll", schedule, { passive: true });
    const sizes = new ResizeObserver(schedule);
    sizes.observe(scroll);
    return () => {
      cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
      sizes.disconnect();
    };
  }, [scroller, table, windowed, count, view]);
  const [start, end] = windowed ? range : [0, count];
  return {
    start,
    end: Math.min(end, count),
    before: windowed ? start * rowHeight.current : 0,
    after: windowed ? Math.max(0, count - end) * rowHeight.current : 0,
  };
}
