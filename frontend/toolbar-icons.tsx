/**
 * Lyrics toolbar icons drawn in parts so each part can move on hover.
 * Shapes are Lucide's (lucide-react 0.577, ISC), split into groups.
 */
import type { ReactNode } from "react";

function Icon({
  name,
  children,
  strokeWidth = 2,
}: {
  name: string;
  children: ReactNode;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={`toolbar-icon toolbar-icon-${name}`}
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 文A: the symbol comes forward on hover and stays while romanizing. */
export const TranslateIcon = () => (
  <Icon name="translate">
    <g className="part-symbol">
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
    </g>
    <g className="part-latin">
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </g>
  </Icon>
);

/** A level meter: the inner bars dip and the outer ones rise on hover. */
export const WordSyncIcon = () => (
  <Icon name="word-sync">
    {["M2 10v3", "M6 6v11", "M10 3v18", "M14 8v7", "M18 5v13", "M22 10v3"].map(
      (d, index) => (
        <path key={d} d={d} className={`part-bar part-bar-${index}`} />
      ),
    )}
  </Icon>
);

/** A moon on its orbit; the orbit tilts on hover. */
export const GravityIcon = () => (
  <Icon name="gravity" strokeWidth={1.8}>
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    <g className="part-orbit">
      <ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-36 12 12)" />
      <circle cx="19.7" cy="6.4" r="2.1" fill="currentColor" stroke="none" />
    </g>
  </Icon>
);

/** A marker pen over the line it draws. */
export const HighlighterIcon = () => (
  <Icon name="highlighter" strokeWidth={1.8}>
    <g className="part-pen">
      <path d="m8 13 8.7-8.7a1.8 1.8 0 0 1 2.6 0l.4.4a1.8 1.8 0 0 1 0 2.6L11 16l-3-3Z" />
      <path d="m8 13-2 2 3 3 2-2m-5-1-2 3 2 1 3-1" />
    </g>
    <path className="part-stroke" d="M4 21h15" pathLength={1} />
  </Icon>
);

/** Three level bars; the short one rises and the others dip on hover. */
export const VisualiserIcon = () => (
  <Icon name="visualiser" strokeWidth={1.8}>
    <path className="part-level" d="M5 21v-6" />
    <path className="part-level" d="M12 21V3" />
    <path className="part-level" d="M19 21V9" />
  </Icon>
);

/** Effects that can be pinned to the lyrics toolbar from Settings. */
export const PINNABLE_EFFECTS = {
  space_gravity: { label: "Space Gravity", Icon: GravityIcon },
  lyrics_highlighter: { label: "Highlighter", Icon: HighlighterIcon },
  lyrics_visualiser: { label: "Visualiser", Icon: VisualiserIcon },
} as const;

/** Rows that squeeze together. */
export const CompactIcon = () => (
  <Icon name="compact">
    <rect width="18" height="18" x="3" y="3" rx="2" className="part-frame" />
    <path d="M21 9H3" className="part-row-top" />
    <path d="M21 15H3" className="part-row-bottom" />
  </Icon>
);

/** A panel whose chevron and divider shift left on hover. */
export const HideArtworkIcon = () => (
  <Icon name="hide-artwork">
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" className="part-divider" />
    <path d="m16 15-3-3 3-3" className="part-chevron" />
  </Icon>
);

/** Two arrows that part on hover. */
export const SwapSidesIcon = () => (
  <Icon name="swap">
    <g className="part-left">
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h16" />
    </g>
    <g className="part-right">
      <path d="m16 21 4-4-4-4" />
      <path d="M20 17H4" />
    </g>
  </Icon>
);

/** An arrow that lifts out of its tray on hover. */
/** Lines and a note: the note lifts on hover. */
export const SourceIcon = () => (
  <Icon name="source">
    <path d="M16 5H3" />
    <path d="M11 12H3" />
    <path d="M11 19H3" />
    <g className="part-note">
      <path d="M21 16V5" />
      <circle cx="18" cy="16" r="3" />
    </g>
  </Icon>
);

export const UploadIcon = () => (
  <Icon name="upload">
    <g className="part-arrow">
      <path d="M12 3v12" />
      <path d="m17 8-5-5-5 5" />
    </g>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  </Icon>
);

/** Arrows that turn part way on hover. */
export const RetryIcon = () => (
  <Icon name="retry">
    <g className="part-spinner">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </g>
  </Icon>
);

/** Corners that push outward on hover. */
export const FullScreenIcon = () => (
  <Icon name="fullscreen">
    <g className="part-corner-out">
      <path d="M15 3h6v6" />
      <path d="m21 3-7 7" />
    </g>
    <g className="part-corner-in">
      <path d="m3 21 7-7" />
      <path d="M9 21H3v-6" />
    </g>
  </Icon>
);

/** A tray with an arrow rising out of it: lyrics in a window of their
 *  own. The pixels-spicy-lyrics fork's `ExternalCinema` icon, as written
 *  (`src/components/Styling/Icons.ts`, AGPL-3.0). */
export const CinemaIcon = () => (
  // The glyph runs from y 4 to 21.5; the box is moved down 0.75 so it
  // sits centred like its neighbours.
  <svg
    width="22"
    height="22"
    viewBox="0 0.75 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 10.5H6.75A1.75 1.75 0 0 0 5 12.25v7.5c0 .97.78 1.75 1.75 1.75h10.5c.97 0 1.75-.78 1.75-1.75v-7.5a1.75 1.75 0 0 0-1.75-1.75H16" />
    <path d="M12 14V4" />
    <path d="m8.5 7.5 3.5-3.5 3.5 3.5" />
  </svg>
);

/** A screen with a filled window in its corner: the lyrics popout. The
 *  fork's `PiPMode` icon, as written (AGPL-3.0). */
export const PopoutIcon = () => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M16 2.45c0-.8-.65-1.45-1.45-1.45H1.45C.65 1 0 1.65 0 2.45v11.1C0 14.35.65 15 1.45 15h5.557v-1.5H1.5v-11h13V7H16z" />
    <path d="M15.25 9.007a.75.75 0 0 1 .75.75v4.493a.75.75 0 0 1-.75.75H9.325a.75.75 0 0 1-.75-.75V9.757a.75.75 0 0 1 .75-.75z" />
  </svg>
);
