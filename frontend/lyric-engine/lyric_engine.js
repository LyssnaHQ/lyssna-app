/* @ts-self-types="./lyric_engine.d.ts" */

export class Countdown {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CountdownFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_countdown_free(ptr, 0);
    }
    /**
     * Targets and result as `opacity, scale, glow, lift` fours.
     * @param {Float64Array} targets
     * @param {number} time
     * @param {number} now
     * @param {boolean} snap
     * @returns {Float64Array}
     */
    frame(targets, time, now, snap) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF64ToWasm0(targets, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.countdown_frame(retptr, this.__wbg_ptr, ptr0, len0, time, now, snap);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 8, 8);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    constructor() {
        const ret = wasm.countdown_new();
        this.__wbg_ptr = ret;
        CountdownFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Countdown.prototype[Symbol.dispose] = Countdown.prototype.free;

export class Spline {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SplineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_spline_free(ptr, 0);
    }
    /**
     * @param {number} x
     * @returns {number}
     */
    at(x) {
        const ret = wasm.spline_at(this.__wbg_ptr, x);
        return ret;
    }
    /**
     * Points as `x, y` pairs.
     * @param {Float64Array} points
     */
    constructor(points) {
        const ptr0 = passArrayF64ToWasm0(points, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.spline_new(ptr0, len0);
        this.__wbg_ptr = ret;
        SplineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Spline.prototype[Symbol.dispose] = Spline.prototype.free;

export class Spring {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SpringFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_spring_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    get asleep() {
        const ret = wasm.spring_asleep(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get damping() {
        const ret = wasm.spring_damping(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get goal() {
        const ret = wasm.spring_goal(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} position
     * @param {number} frequency
     * @param {number} damping
     */
    constructor(position, frequency, damping) {
        const ret = wasm.spring_new(position, frequency, damping);
        this.__wbg_ptr = ret;
        SpringFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    get position() {
        const ret = wasm.spring_position(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} value
     */
    set damping(value) {
        wasm.spring_set_damping(this.__wbg_ptr, value);
    }
    /**
     * @param {number} value
     */
    set goal(value) {
        wasm.spring_set_goal(this.__wbg_ptr, value);
    }
    /**
     * @param {number} value
     */
    set position(value) {
        wasm.spring_set_position(this.__wbg_ptr, value);
    }
    /**
     * @param {number} value
     */
    set velocity(value) {
        wasm.spring_set_velocity(this.__wbg_ptr, value);
    }
    /**
     * @param {number} seconds
     * @returns {number}
     */
    step(seconds) {
        const ret = wasm.spring_step(this.__wbg_ptr, seconds);
        return ret;
    }
    /**
     * @returns {number}
     */
    get velocity() {
        const ret = wasm.spring_velocity(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) Spring.prototype[Symbol.dispose] = Spring.prototype.free;

/**
 * One rendered syllable of a live line, with its held word's letters. The
 * animator steps it every frame and writes the values it returns.
 */
export class Syllable {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SyllableFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_syllable_free(ptr, 0);
    }
    /**
     * `letters` is how many of the held word's letters this piece shows,
     * starting at `letter_offset` of `letter_count`.
     * @param {number} start
     * @param {number} end
     * @param {boolean} emphasis
     * @param {number} letters
     * @param {number} letter_offset
     * @param {number} letter_count
     * @param {number} calm
     * @param {boolean} simple
     */
    constructor(start, end, emphasis, letters, letter_offset, letter_count, calm, simple) {
        const ret = wasm.syllable_new(start, end, emphasis, letters, letter_offset, letter_count, calm, simple);
        this.__wbg_ptr = ret;
        SyllableFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Steps the springs to song `time` and reports whether any still move.
     * @param {number} time
     * @param {number} seconds
     * @param {boolean} reduce_motion
     * @returns {boolean}
     */
    step(time, seconds, reduce_motion) {
        const ret = wasm.syllable_step(this.__wbg_ptr, time, seconds, reduce_motion);
        return ret !== 0;
    }
    /**
     * The values the last step produced, piece by piece, word first.
     * @returns {Float64Array}
     */
    values() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.syllable_values(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export3(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) Syllable.prototype[Symbol.dispose] = Syllable.prototype.free;

/**
 * Three dots as `opacity, scale, glow, lift` fours.
 * @param {number} gap_start
 * @param {number} gap_end
 * @param {number} time
 * @param {boolean} reduce_motion
 * @returns {Float64Array}
 */
export function countdownDots(gap_start, gap_end, time, reduce_motion) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.countdownDots(retptr, gap_start, gap_end, time, reduce_motion);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {number} gap_start
 * @param {number} gap_end
 * @param {number} time
 * @returns {boolean}
 */
export function countdownVisible(gap_start, gap_end, time) {
    const ret = wasm.countdownVisible(gap_start, gap_end, time);
    return ret !== 0;
}

/**
 * @param {number} from
 * @param {number} to
 * @param {number} elapsed
 * @returns {number}
 */
export function glideScroll(from, to, elapsed) {
    const ret = wasm.glideScroll(from, to, elapsed);
    return ret;
}

/**
 * @param {number} start
 * @param {number} end
 * @param {string} text
 * @param {boolean} estimated
 * @returns {boolean}
 */
export function isEmphasis(start, end, text, estimated) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.isEmphasis(start, end, ptr0, len0, estimated);
    return ret !== 0;
}

/**
 * @param {number} start
 * @param {number} end
 * @param {number} time
 * @param {number} count
 * @returns {Float64Array}
 */
export function letterGoals(start, end, time, count) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.letterGoals(retptr, start, end, time, count);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {number} distance
 * @returns {number}
 */
export function lineBlur(distance) {
    const ret = wasm.lineBlur(distance);
    return ret;
}

/**
 * Fill position of a line without word timing, or NaN when it should rest.
 * @param {number} start
 * @param {number} end
 * @param {number} time
 * @param {boolean} simple
 * @returns {number}
 */
export function lineWipe(start, end, time, simple) {
    const ret = wasm.lineWipe(start, end, time, simple);
    return ret;
}

/**
 * 0 scale, 1 letter scale, 2 lift, 3 letter lift, 4 glow.
 * @param {number} curve
 * @param {number} x
 * @returns {number}
 */
export function motionCurve(curve, x) {
    const ret = wasm.motionCurve(curve, x);
    return ret;
}

/**
 * Scalars and spring settings, in the order `lyric-motion.ts` reads them.
 * @returns {Float64Array}
 */
export function motionSettings() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.motionSettings(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {number} start
 * @param {number} end
 * @param {number} time
 * @returns {Float64Array}
 */
export function simpleGoal(start, end, time) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.simpleGoal(retptr, start, end, time);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {number} position
 * @param {number} velocity
 * @param {number} target
 * @param {number} seconds
 * @returns {Float64Array}
 */
export function stepScroll(position, velocity, target, seconds) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.stepScroll(retptr, position, velocity, target, seconds);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 0 unsung, 1 active, 2 sung.
 * @param {number} start
 * @param {number} end
 * @param {number} time
 * @returns {number}
 */
export function sungState(start, end, time) {
    const ret = wasm.sungState(start, end, time);
    return ret;
}

/**
 * @param {boolean} legacy
 * @param {number} idle_scale
 * @param {number} word_peak_scale
 * @param {number} letter_peak_scale
 * @param {number} vertical_strength
 * @param {number} glow_strength
 * @param {number} scale_frequency
 * @param {number} scale_damping
 * @param {number} vertical_frequency
 * @param {number} vertical_damping
 * @param {number} glow_frequency
 * @param {number} glow_damping
 * @param {number} blur_strength
 */
export function tuneMotion(legacy, idle_scale, word_peak_scale, letter_peak_scale, vertical_strength, glow_strength, scale_frequency, scale_damping, vertical_frequency, vertical_damping, glow_frequency, glow_damping, blur_strength) {
    wasm.tuneMotion(legacy, idle_scale, word_peak_scale, letter_peak_scale, vertical_strength, glow_strength, scale_frequency, scale_damping, vertical_frequency, vertical_damping, glow_frequency, glow_damping, blur_strength);
}

/**
 * @param {number} end
 * @param {Float64Array} word_ends
 * @returns {number}
 */
export function vocalEnd(end, word_ends) {
    const ptr0 = passArrayF64ToWasm0(word_ends, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.vocalEnd(end, ptr0, len0);
    return ret;
}

/**
 * @param {Float64Array} lines
 * @param {number} time
 * @returns {Float64Array}
 */
export function vocalGap(lines, time) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(lines, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.vocalGap(retptr, ptr0, len0, time);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 8, 8);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Lines as `start, end, opposite, word count, word ends…`; gaps come back as
 * `start, end, after, opposite` fours.
 * @param {Float64Array} lines
 * @returns {Float64Array}
 */
export function vocalGaps(lines) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF64ToWasm0(lines, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.vocalGaps(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 8, 8);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {number} start
 * @param {number} end
 * @param {number} time
 * @returns {Float64Array}
 */
export function wordGoal(start, end, time) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.wordGoal(retptr, start, end, time);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * @param {string[]} texts
 * @returns {Uint32Array}
 */
export function wordGroupSizes(texts) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayJsValueToWasm0(texts, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.wordGroupSizes(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayU32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 4, 4);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = getObject(arg1);
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./lyric_engine_bg.js": import0,
    };
}

const CountdownFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_countdown_free(ptr, 1));
const SplineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_spline_free(ptr, 1));
const SpringFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_spring_free(ptr, 1));
const SyllableFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_syllable_free(ptr, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    const mem = getDataViewMemory0();
    for (let i = 0; i < array.length; i++) {
        mem.setUint32(ptr + 4 * i, addHeapObject(array[i]), true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }


    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
