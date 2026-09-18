use quote::ToTokens;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{self, BufRead};
use syn::spanned::Spanned;
use syn::visit::Visit;
use syn::{parse_file, ExprMatch, Pat, Lit};

/// One `match`, kept apart from the others in its file (#310).
///
/// The flat per-file list this helper used to print is the right unit for
/// asking whether the reader invents or loses a label. It is the wrong unit for
/// asking whether a box that names *one* dispatch gets that dispatch judged:
/// with the labels of two `match`es in one bag, a correct claim about one of
/// them reads as a claim missing half its cases.
///
/// So the grouping is reported too, and the file total is still derived from
/// it, which is what keeps the two from drifting apart.
#[derive(Serialize)]
struct Dispatch {
    /// The matched expression, as `syn` prints it back: `self . state`. The
    /// spacing is a token stream's and nothing else's, so whoever compares it
    /// compares it past whitespace.
    subject: String,
    cases: Vec<String>,
    /// 1-based line of the `match` keyword, for attributing it to a routine.
    line: usize,
    /// The function this `match` is written inside, innermost first.
    ///
    /// Reported by the referee rather than worked out by the caller, and that
    /// is the point. The line-based harness bounded a routine by *the next
    /// routine it happened to find*, which in one 1,800-line file was 40 of
    /// them -- so every `match` in the gap was attributed to whichever routine
    /// came before it, and a correct reading of the real routine came back as
    /// a disagreement (#310). `syn` knows which `fn` it is inside, and it is
    /// not the parser the reader uses, so saying so costs no independence.
    ///
    /// Empty for a `match` outside any function: a `const`, a static
    /// initialiser.
    routine: Option<String>,
}

#[derive(Serialize)]
struct FileReading {
    /// Every label in the file, in source order. What the flat reading was.
    cases: Vec<String>,
    dispatches: Vec<Dispatch>,
}

/// Extract case names from a Rust pattern, following the same rules as src/engine/handles.ts
fn extract_case_names(pat: &Pat) -> Vec<String> {
    let mut names = Vec::new();
    extract_names_from_pattern(pat, &mut names);
    names
}

/// Recursively extract names from a pattern
fn extract_names_from_pattern(pat: &Pat, out: &mut Vec<String>) {
    match pat {
        // Wildcard _ - never a case
        Pat::Wild(_) => {
            // Do nothing, this is a catch-all
        }

        // Path patterns like Event::Key or Method::Get
        Pat::Path(pat_path) => {
            if let Some(ident) = pat_path.path.get_ident() {
                // Bare identifier - check if it's a binding
                let text = ident.to_string();
                if is_binding(&text) {
                    // Bare lowercase identifier - binding, not a case
                    return;
                }
                // Bare identifier that looks like a constant - it's a case
                out.push(text);
            } else {
                // Qualified path like Event::Key or Method::Get
                if let Some(last_segment) = pat_path.path.segments.last() {
                    out.push(last_segment.ident.to_string());
                }
            }
        }

        // Struct patterns like Event::Click { x, .. }
        Pat::Struct(pat_struct) => {
            if let Some(last_segment) = pat_struct.path.segments.last() {
                out.push(last_segment.ident.to_string());
            }
        }

        // Tuple struct patterns like Ok(v) or Event::Scroll(_)
        Pat::TupleStruct(pat_tuple) => {
            if let Some(last_segment) = pat_tuple.path.segments.last() {
                out.push(last_segment.ident.to_string());
            }
        }

        // Tuple patterns like (a, b) - need to recurse
        Pat::Tuple(pat_tuple) => {
            for elem in &pat_tuple.elems {
                extract_names_from_pattern(elem, out);
            }
        }

        // Or patterns like A | B
        Pat::Or(pat_or) => {
            for pat_elem in &pat_or.cases {
                extract_names_from_pattern(pat_elem, out);
            }
        }

        // Literal patterns like "GET" or 0
        Pat::Lit(pat_lit) => {
            match &pat_lit.lit {
                Lit::Str(lit_str) => {
                    // String literal - take its value directly
                    out.push(lit_str.value());
                }
                Lit::Char(lit_char) => {
                    // Character literal - take the character value
                    out.push(lit_char.value().to_string());
                }
                Lit::Byte(_) => {
                    // Refuse byte literals
                }
                Lit::ByteStr(_) => {
                    // Refuse byte string literals
                }
                Lit::Int(lit_int) => {
                    out.push(lit_int.base10_digits().to_string());
                }
                Lit::Float(lit_float) => {
                    let float_str = lit_float.base10_digits().to_string();
                    out.push(float_str);
                }
                Lit::Bool(lit_bool) => {
                    out.push(lit_bool.value.to_string());
                }
                _ => {
                    // Other literal types - refuse them
                }
            }
        }

        // Ident patterns - these are bindings
        Pat::Ident(pat_ident) => {
            let text = pat_ident.ident.to_string();
            if !is_binding(&text) {
                out.push(text);
            }
            // Otherwise it's a binding, refuse it
        }

        // Slice patterns like [a, b] - we'll recurse on elements
        Pat::Slice(pat_slice) => {
            for elem in &pat_slice.elems {
                extract_names_from_pattern(elem, out);
            }
        }

        // Reference patterns like &x - recurse on the inner pattern
        Pat::Reference(pat_ref) => {
            extract_names_from_pattern(&pat_ref.pat, out);
        }

        // For other pattern types, ignore them
        _ => {}
    }
}

/// Check if text is a bare lowercase identifier (binding pattern)
/// Bindings like 'x', '_unused' should be refused
fn is_binding(text: &str) -> bool {
    // Pattern: starts with lowercase letter or underscore, followed by word chars
    text.chars().next().map_or(false, |c| c.is_lowercase() || c == '_')
        && text.chars().all(|c| c.is_alphanumeric() || c == '_')
}

/// A visitor that collects all match expressions, with the `fn` each is inside.
struct MatchVisitor {
    matches: Vec<(ExprMatch, Option<String>)>,
    /// The functions currently open, outermost first. A closure does not push:
    /// it is part of the body of the `fn` that writes it, which is the routine
    /// a box would point at.
    open: Vec<String>,
}

impl MatchVisitor {
    fn innermost(&self) -> Option<String> {
        self.open.last().cloned()
    }
}

impl<'a> Visit<'a> for MatchVisitor {
    fn visit_expr_match(&mut self, node: &'a ExprMatch) {
        self.matches.push((node.clone(), self.innermost()));
        // Continue visiting nested matches
        syn::visit::visit_expr_match(self, node);
    }

    fn visit_item_fn(&mut self, node: &'a syn::ItemFn) {
        self.open.push(node.sig.ident.to_string());
        syn::visit::visit_item_fn(self, node);
        self.open.pop();
    }

    fn visit_impl_item_fn(&mut self, node: &'a syn::ImplItemFn) {
        self.open.push(node.sig.ident.to_string());
        syn::visit::visit_impl_item_fn(self, node);
        self.open.pop();
    }

    fn visit_trait_item_fn(&mut self, node: &'a syn::TraitItemFn) {
        self.open.push(node.sig.ident.to_string());
        syn::visit::visit_trait_item_fn(self, node);
        self.open.pop();
    }
}

/// Process one Rust file and extract match arm case names, per `match`.
fn process_file(path: &str, code: &str) -> Result<FileReading, String> {
    let file = parse_file(code).map_err(|e| format!("Parse error in {}: {}", path, e))?;

    // Collect all match expressions
    let mut visitor = MatchVisitor {
        matches: Vec::new(),
        open: Vec::new(),
    };
    visitor.visit_file(&file);

    let mut dispatches = Vec::new();

    // Extract cases from each match
    for (match_expr, routine) in visitor.matches {
        let mut cases = Vec::new();
        for arm in &match_expr.arms {
            cases.extend(extract_case_names(&arm.pat));
        }
        dispatches.push(Dispatch {
            subject: match_expr.expr.to_token_stream().to_string(),
            cases,
            line: match_expr.match_token.span().start().line,
            routine,
        });
    }

    // The flat reading, derived rather than collected a second time.
    let all_cases = dispatches
        .iter()
        .flat_map(|dispatch| dispatch.cases.iter().cloned())
        .collect();

    Ok(FileReading { cases: all_cases, dispatches })
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut results = HashMap::new();

    // Read file paths from stdin
    for line in stdin.lock().lines() {
        let path = line?;
        if path.is_empty() {
            continue;
        }

        // Read the file
        match std::fs::read_to_string(&path) {
            Ok(code) => {
                match process_file(&path, &code) {
                    Ok(reading) => {
                        results.insert(path, reading);
                    }
                    Err(e) => {
                        eprintln!("Error processing {}: {}", path, e);
                        results.insert(path, FileReading { cases: Vec::new(), dispatches: Vec::new() });
                    }
                }
            }
            Err(e) => {
                eprintln!("Error reading {}: {}", path, e);
                results.insert(path, FileReading { cases: Vec::new(), dispatches: Vec::new() });
            }
        }
    }

    // Output as JSON
    let json = serde_json::to_string(&results)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    println!("{}", json);

    Ok(())
}
