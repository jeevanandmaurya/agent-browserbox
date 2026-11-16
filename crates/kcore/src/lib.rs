//! kcore — the BrowserBox kernel's hot paths, compiled to WebAssembly.
//!
//! Dependency-free, `no_std`-style ABI: the host allocates buffers with
//! `alloc`, writes bytes into linear memory, and calls the exports below.
//! All functions are memory-safe with respect to the lengths the host passes.

use std::alloc::{alloc as sys_alloc, dealloc as sys_dealloc, Layout};
use std::slice;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::dangling().as_ptr();
    }
    unsafe { sys_alloc(Layout::from_size_align_unchecked(len, 1)) }
}

/// # Safety
/// `ptr` must come from `alloc(len)`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len != 0 {
        sys_dealloc(ptr, Layout::from_size_align_unchecked(len, 1));
    }
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { slice::from_raw_parts(ptr, len) }
}

/// FNV-1a 64-bit hash — used for content addressing and change detection.
///
/// # Safety
/// `ptr..ptr+len` must be valid.
#[no_mangle]
pub unsafe extern "C" fn fnv1a64(ptr: *const u8, len: usize) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes(ptr, len) {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[inline]
fn lower(b: u8) -> u8 {
    if b.is_ascii_uppercase() { b | 0x20 } else { b }
}

fn find(hay: &[u8], needle: &[u8], icase: bool) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > hay.len() {
        return false;
    }
    let first = if icase { lower(needle[0]) } else { needle[0] };
    let last = hay.len() - needle.len();
    let mut i = 0;
    while i <= last {
        let c = if icase { lower(hay[i]) } else { hay[i] };
        if c == first {
            let window = &hay[i..i + needle.len()];
            let ok = if icase {
                window.iter().zip(needle).all(|(a, b)| lower(*a) == lower(*b))
            } else {
                window == needle
            };
            if ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Literal line search. Writes up to `out_cap` matches as `(line_no, byte_offset)`
/// u32 pairs into `out` and returns the total number of matching lines.
/// `flags & 1` → ASCII case-insensitive.
///
/// # Safety
/// All pointer/length pairs must be valid; `out` must hold `out_cap * 2` u32s.
#[no_mangle]
pub unsafe extern "C" fn search_lines(
    hay: *const u8,
    hay_len: usize,
    needle: *const u8,
    needle_len: usize,
    flags: u32,
    out: *mut u32,
    out_cap: usize,
) -> u32 {
    let hay = bytes(hay, hay_len);
    let needle = bytes(needle, needle_len);
    let icase = flags & 1 != 0;
    let mut total: u32 = 0;
    let mut line_no: u32 = 1;
    let mut start = 0usize;
    let mut i = 0usize;
    while i <= hay.len() {
        if i == hay.len() || hay[i] == b'\n' {
            if (i > start || i < hay.len()) && find(&hay[start..i], needle, icase) {
                if (total as usize) < out_cap {
                    *out.add(total as usize * 2) = line_no;
                    *out.add(total as usize * 2 + 1) = start as u32;
                }
                total += 1;
            }
            line_no += 1;
            start = i + 1;
        }
        i += 1;
    }
    total
}

/// Counts `[lines, words, bytes]` into `out` (3 × u32).
///
/// # Safety
/// `out` must hold 3 u32s.
#[no_mangle]
pub unsafe extern "C" fn wc(ptr: *const u8, len: usize, out: *mut u32) {
    let data = bytes(ptr, len);
    let (mut lines, mut words, mut in_word) = (0u32, 0u32, false);
    for &b in data {
        if b == b'\n' {
            lines += 1;
        }
        let ws = b.is_ascii_whitespace();
        if !ws && !in_word {
            words += 1;
        }
        in_word = !ws;
    }
    *out = lines;
    *out.add(1) = words;
    *out.add(2) = len as u32;
}

/// Cheap LLM token estimate (≈ BPE): word pieces of ≤4 chars plus punctuation.
///
/// # Safety
/// `ptr..ptr+len` must be valid.
#[no_mangle]
pub unsafe extern "C" fn estimate_tokens(ptr: *const u8, len: usize) -> u32 {
    let mut tokens = 0u32;
    let mut run = 0u32;
    for &b in bytes(ptr, len) {
        if b.is_ascii_alphanumeric() || b >= 0x80 {
            run += 1;
            if run == 4 {
                tokens += 1;
                run = 0;
            }
        } else {
            if run > 0 {
                tokens += 1;
                run = 0;
            }
            if !b.is_ascii_whitespace() {
                tokens += 1;
            }
        }
    }
    if run > 0 {
        tokens += 1;
    }
    tokens
}
