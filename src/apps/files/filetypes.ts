import type { IconName } from '@/ui/icons';
import { kindOf, type FileKind } from '@/kernel/filetypes';

export * from '@/kernel/filetypes';

const ICONS: Record<FileKind, IconName> = {
  dir: 'folder', text: 'fileText', code: 'code', markdown: 'fileText', html: 'globe', image: 'image', svg: 'image',
  audio: 'music', video: 'film', pdf: 'fileText', archive: 'box', binary: 'file',
};

export function iconFor(name: string, isDir = false): IconName {
  return ICONS[kindOf(name, isDir)];
}
