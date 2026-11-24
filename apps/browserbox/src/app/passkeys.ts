import type { PasskeyInfo } from '@jeevanand/agent-browserbox-runtime/client';

/**
 * Passkeys that unlock a profile (WebAuthn with the PRF extension). The
 * authenticator (fingerprint, face, a security key) gives a secret for the
 * profile's random `input`; the kernel turns it into the key that unwraps the
 * profile's data key. Nothing leaves the device, and there is no server: the
 * secret itself is the proof.
 */
export const passkeysAvailable = (): boolean => typeof PublicKeyCredential !== 'undefined' && globalThis.isSecureContext === true && !!navigator.credentials;

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };
const prfOf = (c: PublicKeyCredential): PrfResults | undefined => (c.getClientExtensionResults() as { prf?: PrfResults }).prf;
const bytes = (b: BufferSource): Uint8Array<ArrayBuffer> => new Uint8Array(b instanceof ArrayBuffer ? b : (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const challenge = () => crypto.getRandomValues(new Uint8Array(32));

export class PasskeyError extends Error {}

/** Makes a passkey for a profile and returns it with its PRF output, ready for `secrets.addPasskey`. */
export async function createPasskey(profile: { id: string; name: string }): Promise<{ id: string; input: Uint8Array<ArrayBuffer>; prf: Uint8Array<ArrayBuffer> }> {
  const input = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'BrowserBox' },
      user: { id: new TextEncoder().encode(`bbx:${profile.id}`), name: profile.name, displayName: `${profile.name} (BrowserBox)` },
      challenge: challenge(),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      extensions: { prf: { eval: { first: input } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new PasskeyError('No passkey was made.');
  const prf = prfOf(cred);
  if (prf?.enabled === false) throw new PasskeyError('This passkey cannot unlock keys: its authenticator has no PRF support. Try another (a phone, a security key, or this computer’s own).');
  // Some authenticators give the secret only when the passkey is used: use it once now.
  const first = prf?.results?.first ? bytes(prf.results.first) : (await usePasskey([{ id: cred.id, input }])).prf;
  return { id: cred.id, input, prf: first };
}

/** Asks for one of these passkeys; returns which one and its PRF output. */
export async function usePasskey(keys: Array<Pick<PasskeyInfo, 'id' | 'input'>>): Promise<{ id: string; prf: Uint8Array<ArrayBuffer> }> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: challenge(),
      allowCredentials: keys.map((k) => ({ type: 'public-key', id: fromB64url(k.id) })),
      userVerification: 'required',
      extensions: { prf: { evalByCredential: Object.fromEntries(keys.map((k) => [k.id, { first: k.input }])) } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new PasskeyError('No passkey was used.');
  const first = prfOf(cred)?.results?.first;
  if (!first) throw new PasskeyError('This browser or passkey did not give the secret that unlocks keys (WebAuthn PRF).');
  return { id: cred.id, prf: bytes(first) };
}

/** A readable reason for a failed passkey step; null when you cancelled it. */
export function passkeyProblem(err: unknown): string | null {
  const e = err as DOMException;
  if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return null;
  return e?.message || String(err);
}
