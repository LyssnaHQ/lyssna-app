import { useEffect, useRef, useState } from "react";
import { List } from "lucide-react";

const SORTS = [
  ["order", "Playlist order"],
  ["title_asc", "Title"],
  ["album_asc", "Album"],
  ["recent", "Recently added"],
  ["added_oldest", "Oldest added"],
  ["newest", "Newest releases"],
  ["oldest", "Oldest releases"],
  ["longest", "Longest"],
  ["shortest", "Shortest"],
  ["popular", "Most played"],
  ["random", "Random"],
] as const;

/**
 * Spotify-style "Recently added ☰" button: one popover holding the playlist
 * sort plus the release-age and length filters, so the action bar stays on
 * one line.
 */
export function SongSortMenu({
  sort,
  age,
  length,
  onSort,
  onAge,
  onLength,
}: {
  sort: string;
  age: string;
  length: string;
  onSort: (value: string) => void;
  onAge: (value: string) => void;
  onLength: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  // Header clicks can also sort descending by title or album.
  const label =
    SORTS.find(([value]) => value === sort)?.[1] ??
    ({ title_desc: "Title", album_desc: "Album" } as Record<string, string>)[
      sort
    ] ??
    "Custom order";
  const filtered = !!(age || length);
  return (
    <div className="sort-menu-root" ref={root}>
      <button
        className={`sort-menu-button ${filtered ? "filtered" : ""}`}
        title="Sort and filter"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <List size={20} />
      </button>
      {open && (
        <div className="sort-menu" role="dialog" aria-label="Sort and filter">
          <span className="sort-menu-heading">Sort by</span>
          {SORTS.map(([value, name]) => (
            <button
              key={value}
              className={value === sort ? "active" : ""}
              aria-pressed={value === sort}
              onClick={() => onSort(value)}
            >
              {name}
            </button>
          ))}
          <hr />
          <label>
            <span className="sort-menu-heading">Release age</span>
            <select
              aria-label="Release age"
              value={age}
              onChange={(event) => onAge(event.target.value)}
            >
              <option value="">Any release age</option>
              <option value="year">Past year</option>
              <option value="five">1–5 years old</option>
              <option value="ten">5–10 years old</option>
              <option value="older">10+ years old</option>
            </select>
          </label>
          <label>
            <span className="sort-menu-heading">Length</span>
            <select
              aria-label="Length"
              value={length}
              onChange={(event) => onLength(event.target.value)}
            >
              <option value="">Any length</option>
              <option value="under3">Under 3 min</option>
              <option value="3to5">3–5 min</option>
              <option value="5to10">5–10 min</option>
              <option value="over10">Over 10 min</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
