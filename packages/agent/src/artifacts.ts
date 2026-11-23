import type { WithFiles } from './host/os.js';

/**
 * Artifacts: things the agent makes for the user to keep — a document, a web
 * page or small app, a diagram, an SVG, a table, some code. Each is a folder of
 * plain files in the project, so undo, rewind, export and git all work on it:
 *
 *   <project folder>/.artifacts/<id>/artifact.json   title, kind, versions
 *   <project folder>/.artifacts/<id>/v1.html          one file per version
 */
export type ArtifactKind = 'html' | 'markdown' | 'svg' | 'mermaid' | 'code' | 'csv';
export const ARTIFACT_KINDS: ArtifactKind[] = ['html', 'markdown', 'svg', 'mermaid', 'code', 'csv'];
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export interface ArtifactVersion {
  n: number;
  at: number;
  /** What changed, in a few words. */
  note?: string;
}

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  /** For code: the language (ts, py, …), used for the file name and highlighting. */
  language?: string;
  created: number;
  /** The chat that made it. */
  session?: string;
  versions: ArtifactVersion[];
}

export const artifactsDir = (folder: string) => `${folder}/.artifacts`;
const dirOf = (folder: string, id: string) => `${artifactsDir(folder)}/${id}`;

const EXT: Record<ArtifactKind, string> = { html: 'html', markdown: 'md', svg: 'svg', mermaid: 'mmd', code: 'txt', csv: 'csv' };
const ext = (a: Pick<Artifact, 'kind' | 'language'>) => (a.kind === 'code' && a.language && /^[a-z0-9+#-]{1,12}$/i.test(a.language) ? a.language.toLowerCase() : EXT[a.kind]);

/** The file holding a version (the latest when `n` is omitted). */
export const versionPath = (folder: string, a: Artifact, n = a.versions.at(-1)!.n) => `${dirOf(folder, a.id)}/v${n}.${ext(a)}`;
export const artifactFile = (folder: string, id: string) => `${dirOf(folder, id)}/artifact.json`;

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'artifact';

function checkSize(content: string): void {
  if (new TextEncoder().encode(content).length > MAX_ARTIFACT_BYTES) throw new Error('An artifact version can be at most 2 MB. Split it, or write it as a file instead.');
}

export async function readArtifactMeta(os: WithFiles, folder: string, id: string): Promise<Artifact> {
  try {
    return JSON.parse(await os.fs.readText(artifactFile(folder, id))) as Artifact;
  } catch {
    throw new Error(`No artifact "${id}" in this project. list them with read_artifact without an id.`);
  }
}

/** Every artifact in a project folder, most recently changed first. */
export async function listArtifacts(os: WithFiles, folder: string): Promise<Artifact[]> {
  const entries = await os.fs.readdir(artifactsDir(folder)).catch(() => []);
  const all = await Promise.all(entries.filter((e) => e.kind === 'dir').map((e) => readArtifactMeta(os, folder, e.name).catch(() => null)));
  return all.filter((a): a is Artifact => a !== null).sort((a, b) => b.versions.at(-1)!.at - a.versions.at(-1)!.at);
}

export async function createArtifact(os: WithFiles, folder: string, o: { title: string; kind: ArtifactKind; content: string; language?: string; session?: string }): Promise<Artifact> {
  if (!ARTIFACT_KINDS.includes(o.kind)) throw new Error(`kind must be one of ${ARTIFACT_KINDS.join(', ')}`);
  const title = o.title.trim().slice(0, 120);
  if (!title) throw new Error('An artifact needs a title');
  checkSize(o.content);
  const taken = new Set((await os.fs.readdir(artifactsDir(folder)).catch(() => [])).map((e) => e.name));
  let id = slug(title);
  for (let n = 2; taken.has(id); n++) id = `${slug(title)}-${n}`;
  const a: Artifact = { id, title, kind: o.kind, ...(o.language ? { language: o.language } : {}), created: Date.now(), ...(o.session ? { session: o.session } : {}), versions: [{ n: 1, at: Date.now() }] };
  await os.fs.writeFile(versionPath(folder, a, 1), o.content);
  await os.fs.writeFile(artifactFile(folder, id), JSON.stringify(a, null, 2));
  return a;
}

export async function readArtifact(os: WithFiles, folder: string, id: string, n?: number): Promise<{ artifact: Artifact; version: number; content: string }> {
  const artifact = await readArtifactMeta(os, folder, id);
  const version = n ?? artifact.versions.at(-1)!.n;
  if (!artifact.versions.some((v) => v.n === version)) throw new Error(`"${id}" has no version ${version} (it has ${artifact.versions.map((v) => v.n).join(', ')}).`);
  return { artifact, version, content: await os.fs.readText(versionPath(folder, artifact, version)) };
}

/** A new version: the whole content, or exact edits to the latest (each `old` must occur once). */
export async function updateArtifact(os: WithFiles, folder: string, id: string, o: { content?: string; edits?: Array<{ old: string; new: string }>; note?: string }): Promise<Artifact> {
  const { artifact, content: latest } = await readArtifact(os, folder, id);
  let next: string;
  if (o.content !== undefined) next = o.content;
  else if (o.edits?.length) {
    next = latest;
    for (const e of o.edits) {
      const count = e.old ? next.split(e.old).length - 1 : 0;
      if (count !== 1) throw new Error(count ? `"${e.old.slice(0, 60)}" occurs ${count} times; include more context.` : `"${e.old.slice(0, 60)}" is not in the latest version. read_artifact it and match it exactly.`);
      next = next.replace(e.old, () => e.new);
    }
  } else throw new Error('Pass content (the whole new version) or edits.');
  checkSize(next);
  const n = artifact.versions.at(-1)!.n + 1;
  const updated: Artifact = { ...artifact, versions: [...artifact.versions, { n, at: Date.now(), ...(o.note ? { note: o.note.slice(0, 200) } : {}) }] };
  await os.fs.writeFile(versionPath(folder, updated, n), next);
  await os.fs.writeFile(artifactFile(folder, id), JSON.stringify(updated, null, 2));
  return updated;
}

export async function deleteArtifact(os: WithFiles, folder: string, id: string): Promise<void> {
  await os.fs.rm(dirOf(folder, id), { recursive: true });
}
