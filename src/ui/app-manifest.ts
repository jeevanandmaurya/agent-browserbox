/**
 * Describes an app without loading it. Lives in src/apps/<id>/manifest.ts next
 * to the app's code (index.ts); both are discovered automatically, so adding an
 * app means adding a folder. DOM-free, so the kernel can read it too.
 */
export interface AppManifest {
  id: string;
  name: string;
  /** Glyph for the desktop icon. */
  icon: string;
  /** Tile colour for the icon. */
  color: string;
  width: number;
  height: number;
  /** Position in launchers. */
  order: number;
  /** Only one window; launching again focuses it. */
  singleton?: boolean;
  /** Hidden from launchers (opened by other apps). */
  hidden?: boolean;
  /** Opens in its own browser window at this URL instead of inside the desktop. */
  external?: string;
}

const found = import.meta.glob<AppManifest>('/src/apps/*/manifest.ts', { eager: true, import: 'default' });

export const APP_MANIFESTS: readonly AppManifest[] = Object.values(found).sort((a, b) => a.order - b.order);
