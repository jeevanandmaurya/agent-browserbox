/** Feature detection for every platform API BrowserBox can use. */
export interface PlatformCap {
  id: string;
  group: 'Compute' | 'Storage' | 'Graphics & Media' | 'System' | 'Network' | 'Devices' | 'AI';
  label: string;
  ok: boolean;
  /** How the OS uses it. */
  use: string;
}

export function detectCaps(): PlatformCap[] {
  const g = globalThis as unknown as Record<string, unknown>;
  const nav = (globalThis.navigator ?? {}) as unknown as Record<string, unknown>;
  const has = (o: unknown, k: string): boolean => typeof o === 'object' && o !== null && k in (o as object);
  const c = (id: string, group: PlatformCap['group'], label: string, ok: unknown, use: string): PlatformCap => ({ id, group, label, ok: Boolean(ok), use });
  return [
    c('wasm', 'Compute', 'WebAssembly', has(g, 'WebAssembly'), 'Rust kernel core, WASI programs, Pyodide'),
    c('wasm-streaming', 'Compute', 'WASM streaming compile', typeof WebAssembly?.instantiateStreaming === 'function', 'Fast kernel boot'),
    c('workers', 'Compute', 'Web Workers', has(g, 'Worker'), 'Sandboxed code execution'),
    c('sab', 'Compute', 'SharedArrayBuffer', has(g, 'SharedArrayBuffer') && g.crossOriginIsolated === true, 'Threads (needs cross-origin isolation)'),
    c('webgpu', 'Compute', 'WebGPU', has(nav, 'gpu'), 'GPU compute tool, GPU Lab, in-browser LLM'),
    c('scheduler', 'Compute', 'Scheduler API', has(g, 'scheduler'), 'Prioritised background work'),
    c('compression', 'Compute', 'Compression Streams', has(g, 'CompressionStream'), 'gzip / gunzip'),
    c('crypto', 'Compute', 'Web Crypto', has(g.crypto, 'subtle'), 'Secret encryption, hashing'),
    c('opfs', 'Storage', 'Origin Private File System', has(nav.storage, 'getDirectory'), 'Persistent root filesystem'),
    c('fsaccess', 'Storage', 'File System Access', has(g, 'showDirectoryPicker'), 'Mount real folders at /mnt'),
    c('indexeddb', 'Storage', 'IndexedDB', has(g, 'indexedDB'), 'Encrypted secrets'),
    c('persist', 'Storage', 'Persistent storage', has(nav.storage, 'persist'), 'Protect data from eviction'),
    c('cache', 'Storage', 'Cache Storage', has(g, 'caches'), 'Offline boot, model weights'),
    c('sw', 'System', 'Service Worker', has(nav, 'serviceWorker'), 'Instant offline boot'),
    c('locks', 'System', 'Web Locks', has(nav, 'locks'), 'Cross-tab coordination'),
    c('broadcast', 'System', 'BroadcastChannel', has(g, 'BroadcastChannel'), 'Cross-tab filesystem events'),
    c('notifications', 'System', 'Notifications', has(g, 'Notification'), 'Agent task alerts'),
    c('clipboard', 'System', 'Async Clipboard', has(nav, 'clipboard'), 'Clipboard tools'),
    c('wakelock', 'System', 'Screen Wake Lock', has(nav, 'wakeLock'), 'Keep awake during long agent runs'),
    c('share', 'System', 'Web Share', has(nav, 'share'), 'Share files'),
    c('viewtransitions', 'System', 'View Transitions', has(globalThis.document, 'startViewTransition'), 'Window animations'),
    c('memory', 'System', 'Memory measurement', has(globalThis.performance, 'memory') || has(globalThis.performance, 'measureUserAgentSpecificMemory'), 'Task Manager'),
    c('battery', 'System', 'Battery Status', has(nav, 'getBattery'), 'System monitor'),
    c('fetch-stream', 'Network', 'Streaming fetch', has(g, 'ReadableStream'), 'LLM token streaming'),
    c('websocket', 'Network', 'WebSocket', has(g, 'WebSocket'), 'Realtime connections'),
    c('webrtc', 'Network', 'WebRTC', has(g, 'RTCPeerConnection'), 'Peer-to-peer'),
    c('webtransport', 'Network', 'WebTransport', has(g, 'WebTransport'), 'Low-latency transport'),
    c('netinfo', 'Network', 'Network Information', has(nav, 'connection'), 'System monitor'),
    c('offscreen', 'Graphics & Media', 'OffscreenCanvas', has(g, 'OffscreenCanvas'), 'Off-thread rendering'),
    c('webgl2', 'Graphics & Media', 'WebGL 2', has(g, 'WebGL2RenderingContext'), 'Graphics fallback'),
    c('webcodecs', 'Graphics & Media', 'WebCodecs', has(g, 'VideoEncoder'), 'Media processing'),
    c('webaudio', 'Graphics & Media', 'Web Audio', has(g, 'AudioContext'), 'Sound'),
    c('speech-tts', 'Graphics & Media', 'Speech synthesis', has(g, 'speechSynthesis'), 'Agent speak tool'),
    c('speech-stt', 'Graphics & Media', 'Speech recognition', has(g, 'SpeechRecognition') || has(g, 'webkitSpeechRecognition'), 'Voice input'),
    c('capture', 'Graphics & Media', 'Screen Capture', has(nav.mediaDevices, 'getDisplayMedia'), 'Screenshots'),
    c('usb', 'Devices', 'WebUSB', has(nav, 'usb'), 'Hardware access'),
    c('serial', 'Devices', 'Web Serial', has(nav, 'serial'), 'Hardware access'),
    c('bluetooth', 'Devices', 'Web Bluetooth', has(nav, 'bluetooth'), 'Hardware access'),
    c('hid', 'Devices', 'WebHID', has(nav, 'hid'), 'Hardware access'),
    c('gamepad', 'Devices', 'Gamepad', has(nav, 'getGamepads'), 'Input'),
    c('prompt-api', 'AI', 'Built-in Prompt API', has(g, 'LanguageModel'), 'On-device model'),
    c('webnn', 'AI', 'WebNN', has(nav, 'ml'), 'Neural network acceleration'),
  ];
}
