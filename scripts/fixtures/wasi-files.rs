// Source of wasi-files.wasm: a WASI program that exercises file access (read, mkdir -p, write,
// rename, delete, list, stat, env, absolute paths, escape refusal). Rebuild with
// cargo build --release --target wasm32-wasip1 in a crate with this as src/main.rs.
use std::fs;
use std::io::Write;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    // read input file given as arg, count lines, write report, make a dir, rename, delete, list
    let input = fs::read_to_string(&args[1]).expect("read input");
    let lines = input.lines().count();
    fs::create_dir_all("out/deep").unwrap();
    let mut f = fs::File::create("out/deep/report.txt").unwrap();
    writeln!(f, "{} has {} lines", args[1], lines).unwrap();
    fs::write("tmp.txt", "temporary").unwrap();
    fs::rename("tmp.txt", "renamed.txt").unwrap();
    fs::remove_file("delete-me.txt").unwrap();
    let mut names: Vec<String> = fs::read_dir(".").unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    println!("listing: {}", names.join(","));
    println!("HOME={} PWD={}", std::env::var("HOME").unwrap_or_default(), std::env::var("PWD").unwrap_or_default());
    let meta = fs::metadata(&args[1]).unwrap();
    println!("size={}", meta.len());
    // absolute path inside cwd
    let abs = format!("{}/renamed.txt", std::env::var("PWD").unwrap());
    println!("abs read: {}", fs::read_to_string(&abs).unwrap());
    // escaping is refused
    println!("escape: {}", fs::read_to_string("../etc-passwd").is_err());
}
