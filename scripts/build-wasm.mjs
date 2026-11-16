// Builds the Rust kernel core to WebAssembly and copies it into src/kernel/.
import { execSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';

execSync('cargo build --release --target wasm32-unknown-unknown', { cwd: 'crates/kcore', stdio: 'inherit' });
const out = 'src/kernel/kcore.wasm';
copyFileSync('crates/kcore/target/wasm32-unknown-unknown/release/kcore.wasm', out);
console.log(`kcore.wasm → ${out} (${statSync(out).size} bytes)`);
