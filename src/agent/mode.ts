/**
 * Hidden instructions travel with a message in a <mode> tag (plan mode); the
 * chat view does not show it. In its own module so the window does not load
 * the agent loop just for this.
 */
export const MODE_TAG = /\n*<mode>[\s\S]*?<\/mode>\s*$/;
