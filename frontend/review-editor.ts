import type { ReviewSubmission } from "./review-api";

export interface ReviewOpen {
  submission: ReviewSubmission;
  uri: string;
  ttml: string;
}

/** The submission loaded in the TTML Creator, as the review sidebar sees it. */
export interface ReviewDraft {
  id: string;
  changed: boolean;
  /** Submits the editor's lyrics as an edit credited to the reviewer. */
  submit(): Promise<void>;
}

// The review sidebar and the TTML Creator mount and unmount independently.
let request: ReviewOpen | undefined;
let draft: ReviewDraft | undefined;
const listeners = new Set<() => void>();
const update = () => listeners.forEach((listener) => listener());

export const reviewEditor = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  request: () => request,
  draft: () => draft,
  open(next: ReviewOpen) {
    request = next;
    update();
  },
  cancel(expected = request) {
    if (!request || request !== expected) return;
    request = undefined;
    update();
  },
  publish(next?: ReviewDraft) {
    if (draft === next) return;
    draft = next;
    update();
  },
};
