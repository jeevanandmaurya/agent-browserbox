import { ARTIFACT_KINDS, artifactsDir, createArtifact, deleteArtifact, listArtifacts, readArtifact, readArtifactMeta, updateArtifact, versionPath, type ArtifactKind } from '../artifacts.js';
import { clip, obj, tool, type ToolDef } from './types.js';

const artifactFolder = (workspace: string, id: string) => `${artifactsDir(workspace)}/${id}`;

/** The result line the chat recognises to show an artifact card. */
export const artifactLine = (verb: string, a: { id: string; title: string; kind: string }, version: number) => `${verb} artifact "${a.title}" (id: ${a.id}, kind: ${a.kind}, version ${version}).`;

export const artifactTools: ToolDef[] = [
  tool<{ title: string; kind: ArtifactKind; content: string; language?: string }>({
    name: 'create_artifact',
    description:
      'Make something the user keeps: a document (markdown), a web page or small app (html: a complete document; inline CSS/JS; it runs sandboxed), a diagram (mermaid), an image (svg), a table (csv) or code (code, with language). It opens in a panel with versions the user can edit, download and reopen later. Use this for anything worth keeping; use show_html only for a throwaway preview. Change it later with update_artifact rather than making a new one.',
    input_schema: obj(
      {
        title: { type: 'string' },
        kind: { type: 'string', enum: ARTIFACT_KINDS },
        content: { type: 'string' },
        language: { type: 'string', description: 'code only: ts, py, rs, …' },
      },
      ['title', 'kind', 'content'],
    ),
    cap: () => null,
    describe: (i) => `${i.kind} artifact: ${i.title}`,
    async run(i, tc) {
      const a = await createArtifact(tc.os, tc.workspace, { title: i.title, kind: i.kind, content: i.content, language: i.language, session: tc.session });
      tc.created(artifactFolder(tc.workspace, a.id));
      return artifactLine('Created', a, 1);
    },
  }),
  tool<{ id: string; content?: string; edits?: Array<{ old: string; new: string }>; restore?: number; note?: string }>({
    name: 'update_artifact',
    description: 'Make a new version of an artifact: exact edits to the latest version (each old text must occur once; best for small changes), the whole new content, or `restore` an earlier version (it becomes the newest). Earlier versions are kept.',
    input_schema: obj(
      {
        id: { type: 'string' },
        edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] } },
        content: { type: 'string', description: 'the whole new version, instead of edits' },
        restore: { type: 'integer', description: 'an earlier version number to bring back, instead of edits or content' },
        note: { type: 'string', description: 'what changed, in a few words' },
      },
      ['id'],
    ),
    cap: () => null,
    describe: (i) => (i.restore ? `Restore version ${i.restore} of artifact ${i.id}` : `Update artifact ${i.id}${i.note ? `: ${i.note}` : ''}`),
    async run(i, tc) {
      const old = i.restore ? await readArtifact(tc.os, tc.workspace, i.id, i.restore) : null;
      const a = await updateArtifact(tc.os, tc.workspace, i.id, old ? { content: old.content, note: i.note ?? `restored version ${i.restore}` } : { content: i.content, edits: i.edits, note: i.note });
      tc.created(versionPath(tc.workspace, a));
      return artifactLine('Updated', a, a.versions.at(-1)!.n);
    },
  }),
  tool<{ id: string }>({
    name: 'delete_artifact',
    description: 'Delete an artifact with all its versions. Only when the user asks for it to be deleted.',
    input_schema: obj({ id: { type: 'string' } }, ['id']),
    // The user's work: asked for in Ask mode, like changing a file.
    cap: () => 'fs.write',
    describe: (i) => `Delete artifact ${i.id}`,
    async run(i, tc) {
      const a = await readArtifactMeta(tc.os, tc.workspace, i.id);
      await deleteArtifact(tc.os, tc.workspace, i.id);
      return `Deleted artifact "${a.title}" (${a.versions.length} version${a.versions.length === 1 ? '' : 's'}).`;
    },
  }),
  tool<{ id?: string; version?: number }>({
    name: 'read_artifact',
    description: "Read an artifact's latest (or a given) version. Without an id, lists this project's artifacts.",
    input_schema: obj({ id: { type: 'string' }, version: { type: 'integer' } }),
    cap: () => null,
    describe: (i) => (i.id ? `Read artifact ${i.id}` : 'List artifacts'),
    async run(i, tc) {
      if (!i.id) {
        const list = await listArtifacts(tc.os, tc.workspace);
        return list.length ? list.map((a) => `${a.id} · ${a.kind} · v${a.versions.at(-1)!.n} · ${a.title}`).join('\n') : 'No artifacts in this project yet.';
      }
      const r = await readArtifact(tc.os, tc.workspace, i.id, i.version);
      return clip(`# ${r.artifact.title} (${r.artifact.kind}, version ${r.version} of ${r.artifact.versions.length})\n\n${r.content}`, 60_000);
    },
  }),
];
