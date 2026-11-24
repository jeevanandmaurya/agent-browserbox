/** Feature detection for every platform API BrowserBox can use. */
export interface PlatformCap {
  id: string;
  group: 'Compute' | 'Storage' | 'Graphics & Media' | 'System' | 'Network' | 'Devices' | 'AI';
  label: string;
  ok: boolean;
  /** Whether BrowserBox uses it today (otherwise it is only detected). */
  used: boolean;
  /** What BrowserBox uses it for; empty when it is not used. */
  use: string;
}

export function detectCaps(): PlatformCap[] {
  const g = globalThis as unknown as Record<string, unknown>;
  const nav = (globalThis.navigator ?? {}) as unknown as Record<string, unknown>;
  const has = (o: unknown, k: string): boolean => typeof o === 'object' && o !== null && k in (o as object);
  /** `use` names what it is used for; leave it empty for a feature that is only detected. */
  const c = (id: string, group: PlatformCap['group'], label: string, ok: unknown, use = ''): PlatformCap => ({ id, group, label, ok: Boolean(ok), used: use !== '', use });
  return [
    c('wasm', 'Compute', 'WebAssembly', has(g, 'WebAssembly'), 'Rust kernel core, WASI programs, Pyodide'),
    c('wasm-streaming', 'Compute', 'WASM streaming compile', typeof WebAssembly?.instantiateStreaming === 'function', 'Fast kernel boot'),
    c('workers', 'Compute', 'Web Workers', has(g, 'Worker'), 'Sandboxed code execution'),
    c('sab', 'Compute', 'SharedArrayBuffer', has(g, 'SharedArrayBuffer') && g.crossOriginIsolated === true),
    c('webgpu', 'Compute', 'WebGPU', has(nav, 'gpu'), 'GPU compute tool, GPU Lab, models in the browser'),
    c('scheduler', 'Compute', 'Scheduler API', has(g, 'scheduler')),
    c('compression', 'Compute', 'Compression Streams', has(g, 'CompressionStream'), 'gzip and gunzip commands'),
    c('crypto', 'Compute', 'Web Crypto', has(g.crypto, 'subtle'), 'Locking API keys with your password, package checksums'),
    c('opfs', 'Storage', 'Origin Private File System', has(nav.storage, 'getDirectory'), 'Persistent root filesystem'),
    c('fsaccess', 'Storage', 'File System Access', has(g, 'showDirectoryPicker'), 'Mount real folders at /mnt'),
    c('indexeddb', 'Storage', 'IndexedDB', has(g, 'indexedDB'), 'API keys and the kernel state'),
    c('persist', 'Storage', 'Persistent storage', has(nav.storage, 'persist'), 'Protect data from eviction'),
    c('cache', 'Storage', 'Cache Storage', has(g, 'caches'), 'Offline boot, packages, model weights'),
    c('sw', 'System', 'Service Worker', has(nav, 'serviceWorker'), 'Instant offline boot'),
    c('locks', 'System', 'Web Locks', has(nav, 'locks'), 'One kernel per profile across tabs, scheduled tasks'),
    c('broadcast', 'System', 'BroadcastChannel', has(g, 'BroadcastChannel'), 'Cross-tab filesystem events'),
    c('notifications', 'System', 'Notifications', has(g, 'Notification'), 'Agent finished, approvals and questions waiting, scheduled tasks'),
    c('clipboard', 'System', 'Async Clipboard', has(nav, 'clipboard'), 'The agent\'s clipboard tool'),
    c('wakelock', 'System', 'Screen Wake Lock', has(nav, 'wakeLock'), 'Keep awake during long agent runs'),
    c('share', 'System', 'Web Share', has(nav, 'share')),
    c('badging', 'System', 'App badge', has(nav, 'setAppBadge'), 'Chats waiting for you, on the installed app\'s icon'),
    c('file-handling', 'System', 'File Handling', has(g, 'launchQueue'), 'Opening files from your computer with the installed app'),
    c('pip', 'System', 'Document Picture-in-Picture', has(g, 'documentPictureInPicture')),
    c('idle', 'System', 'Idle Detection', has(g, 'IdleDetector')),
    c('passkeys', 'System', 'Passkeys (WebAuthn)', has(g, 'PublicKeyCredential'), 'Signing in to a profile with a passkey'),
    c('viewtransitions', 'System', 'View Transitions', has(globalThis.document, 'startViewTransition')),
    c('memory', 'System', 'Memory measurement', has(globalThis.performance, 'memory') || has(globalThis.performance, 'measureUserAgentSpecificMemory'), 'Task Manager (JavaScript heap)'),
    c('battery', 'System', 'Battery Status', has(nav, 'getBattery'), 'System info, the phone layout\'s status bar'),
    c('fetch-stream', 'Network', 'Streaming fetch', has(g, 'ReadableStream'), 'Streaming model replies'),
    c('websocket', 'Network', 'WebSocket', has(g, 'WebSocket')),
    c('webrtc', 'Network', 'WebRTC', has(g, 'RTCPeerConnection')),
    c('webtransport', 'Network', 'WebTransport', has(g, 'WebTransport')),
    c('netinfo', 'Network', 'Network Information', has(nav, 'connection'), 'Task Manager'),
    c('offscreen', 'Graphics & Media', 'OffscreenCanvas', has(g, 'OffscreenCanvas')),
    c('webgl2', 'Graphics & Media', 'WebGL 2', has(g, 'WebGL2RenderingContext')),
    c('webcodecs', 'Graphics & Media', 'WebCodecs', has(g, 'VideoEncoder')),
    c('webaudio', 'Graphics & Media', 'Web Audio', has(g, 'AudioContext')),
    c('speech-tts', 'Graphics & Media', 'Speech synthesis', has(g, 'speechSynthesis'), 'The agent\'s speak tool'),
    c('speech-stt', 'Graphics & Media', 'Speech recognition', has(g, 'SpeechRecognition') || has(g, 'webkitSpeechRecognition'), 'Dictating a message'),
    c('capture', 'Graphics & Media', 'Screen Capture', has(nav.mediaDevices, 'getDisplayMedia'), 'Sharing a picture of a screen with the agent'),
    c('recorder', 'Graphics & Media', 'MediaRecorder', has(g, 'MediaRecorder')),
    c('usb', 'Devices', 'WebUSB', has(nav, 'usb')),
    c('serial', 'Devices', 'Web Serial', has(nav, 'serial')),
    c('bluetooth', 'Devices', 'Web Bluetooth', has(nav, 'bluetooth')),
    c('hid', 'Devices', 'WebHID', has(nav, 'hid')),
    c('gamepad', 'Devices', 'Gamepad', has(nav, 'getGamepads')),
    c('prompt-api', 'AI', 'Built-in Prompt API', has(g, 'LanguageModel'), 'A model source: the browser\'s own model'),
    c('webnn', 'AI', 'WebNN', has(nav, 'ml')),
  ];
}
