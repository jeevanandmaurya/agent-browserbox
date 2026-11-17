import type { PackageModule } from '../types';
import { gitCommand } from './git';

export default { commands: [gitCommand] } satisfies PackageModule;
