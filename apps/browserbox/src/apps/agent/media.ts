import { h } from '@/ui/dom';
import type { Notice } from '@jeevanand/agent-browserbox-runtime/client';

/** Screen capture and voice notes for the message box, loaded when first used. */

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };

/** The longest side of a captured screen, in pixels: enough to read text, small enough for a model. */
const MAX_CAPTURE = 1920;

/** Asks the browser for a screen, window or tab, takes one frame, and stops sharing at once. */
export async function captureScreen(): Promise<File> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // The first frame can arrive a moment after play() resolves.
    for (let i = 0; i < 50 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 20));
    if (!video.videoWidth) throw new Error('The shared screen sent no picture.');
    const scale = Math.min(1, MAX_CAPTURE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('Could not encode the picture.');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return new File([blob], `screen-${stamp}.png`, { type: 'image/png' });
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

/**
 * Records a voice note: an audio file, and a transcript where speech
 * recognition exists. Returns a function that stops it (then `done` runs), or
 * null when the microphone could not be used.
 */
export async function recordVoiceNote(o: {
  recognition?: new () => Recognition;
  show(chip: HTMLElement): void;
  notify(n: Notice): void;
  done(file: File, transcript: string): Promise<void>;
}): Promise<(() => void) | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    o.notify({ title: 'Could not use the microphone', body: (err as DOMException).name === 'NotAllowedError' ? 'Microphone permission was denied.' : (err as Error).message, level: 'warn' });
    return null;
  }
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const parts: Blob[] = [];
  const clock = h('span', null, '0:00');
  const chip = h('div', { class: 'cp-voice', role: 'status' }, h('span', { class: 'cp-voice-dot', 'aria-hidden': 'true' }), 'Recording a voice note ', clock, h('button', { type: 'button', class: 'btn small', onclick: () => recorder.stop() }, 'Stop'));
  o.show(chip);
  const started = Date.now();
  let transcript = '';
  const timer = window.setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    // A note is kept short: ten minutes at most.
    if (s >= 600) recorder.stop();
  }, 500);
  let rec: Recognition | null = null;
  if (o.recognition) {
    rec = new o.recognition();
    rec.lang = navigator.language;
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) if (e.results[i]!.isFinal) text += e.results[i]![0]!.transcript;
      transcript = text.trim();
    };
    rec.onerror = () => undefined;
    rec.onend = () => undefined;
    try {
      rec.start();
    } catch {
      rec = null;
    }
  }
  recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
  recorder.onstop = async () => {
    clearInterval(timer);
    for (const t of stream.getTracks()) t.stop();
    rec?.stop();
    chip.remove();
    // Recognition sends its last words a moment after it stops.
    await new Promise((r) => setTimeout(r, rec ? 600 : 0));
    const mime = recorder.mimeType || type;
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    await o.done(new File(parts, `voice-${stamp}.${ext}`, { type: mime || 'audio/webm' }), transcript);
  };
  recorder.start(1000);
  return () => recorder.state !== 'inactive' && recorder.stop();
}
