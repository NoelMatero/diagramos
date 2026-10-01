export const fixture = {
  name: "sanity-rs",
  files: {
    "Cargo.toml": '[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/lib.rs": "pub mod b;\npub mod a;\n",
    "src/b.rs": "pub fn double(x: i32) -> i32 { x * 2 }\npub fn triple(x: i32) -> i32 { x * 3 }\npub struct Store;\nimpl Store {\n    pub fn save(&self) -> i32 { 1 }\n}\n",
    "src/a.rs": "use crate::b::{double, Store};\n\npub fn run(x: i32) -> i32 {\n    double(x)\n}\n\npub fn keep(s: &Store) -> i32 {\n    s.save()\n}\n",
  },
  arrows: [
    ["plain call", "src/a.rs#run", "src/b.rs#double", "calls"],
    ["receiver call", "src/a.rs#keep", "src/b.rs#save", "calls"],
    ["receiver call, Type::method ref", "src/a.rs#keep", "src/b.rs#Store::save", "calls"],
    ["PLANTED WRONG", "src/a.rs#run", "src/b.rs#triple", "calls"],
  ],
};
