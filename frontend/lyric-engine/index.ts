import { initSync } from "./lyric_engine.js";
import { WASM } from "./wasm";

// Inlined and compiled synchronously so lyric code can call it at import time,
// in the webview and under vitest alike.
const bytes = Uint8Array.from(atob(WASM), (char) => char.charCodeAt(0));
initSync({ module: bytes });

export * from "./lyric_engine.js";
