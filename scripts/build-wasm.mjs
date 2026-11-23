// Builds the Rust kernel core to WebAssembly and copies it into the runtime (packages/runtime/src/kernel/).
import { execSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';

execSync('cargo build --release --target wasm32-unknown-unknown', { cwd: 'packages/runtime/crates/kcore', stdio: 'inherit' });
const out = 'packages/runtime/src/kernel/kcore.wasm';
copyFileSync('packages/runtime/crates/kcore/target/wasm32-unknown-unknown/release/kcore.wasm', out);
console.log(`kcore.wasm → ${out} (${statSync(out).size} bytes)`);
