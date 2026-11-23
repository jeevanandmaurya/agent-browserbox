/**
 * @jeevanand/agent-browserbox-runtime/client: everything an app may use from
 * the runtime besides the SDK. A full kernel client for the SDK's kernel
 * channel (box.kernelPort()), and the kernel's types and small helpers an app
 * UI needs. The protocol is versioned with the runtime: use the client of the
 * runtime version you run.
 */
export { RemoteKernel } from './remote-kernel';
export type { KernelLink } from './connect';
export { Peer, type Handlers } from '../rpc/peer';

// The kernel's types.
export type { Kernel, FsApi, MountInfo, ProcsApi, SecretsApi, SettingsApi, ShellHandle, ShellIo, ShellsApi } from '../kernel/api';
export type { Capability, PermDecision, PermMode, PermRequest, Prompter } from '../kernel/perms';
export type { Proc, ProcKind, ProcState, SpawnOptions } from '../kernel/proc';
export type { KernelEvents, KernelLogLine, LockState, Notice, ShellAction } from '../kernel/types';
export { createProfile, DEFAULT_PROFILE, deleteProfile, getProfile, lastProfile, listProfiles, setLastProfile, updateProfile, type Profile } from '../kernel/profiles';
export type { Stat } from '../kernel/vfs/types';
export type { DevApi, DevInfo, DevLog, DevLogLevel, DevPage, DevStartOptions, WireRequest, WireResponse } from '../kernel/dev/types';
export type { PlatformCap } from '../kernel/caps';

// Small helpers: paths, file kinds, formatting, terminal text, frames.
export { basename, dirname, extname, isInside, join, normalize, resolve } from '../kernel/vfs/path';
export { AGENT_HOME, HOME } from '../kernel/paths';
export * from '../kernel/filetypes';
export * from '../kernel/format';
export { C, plainText, stripAnsi } from '../shell/ansi';
export { embeddable } from '../sandbox/isolation';
