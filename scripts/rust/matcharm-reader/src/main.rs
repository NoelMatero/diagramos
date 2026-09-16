use std::collections::HashMap;
use std::io::{self, BufRead};
use syn::visit::Visit;
use syn::{parse_file, ExprMatch, Pat, Lit};

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

/// A visitor that collects all match expressions
struct MatchVisitor {
    matches: Vec<ExprMatch>,
}

impl<'a> Visit<'a> for MatchVisitor {
    fn visit_expr_match(&mut self, node: &'a ExprMatch) {
        self.matches.push(node.clone());
        // Continue visiting nested matches
        syn::visit::visit_expr_match(self, node);
    }
}

/// Process one Rust file and extract match arm case names
fn process_file(path: &str, code: &str) -> Result<Vec<String>, String> {
    let file = parse_file(code).map_err(|e| format!("Parse error in {}: {}", path, e))?;

    // Collect all match expressions
    let mut visitor = MatchVisitor {
        matches: Vec::new(),
    };
    visitor.visit_file(&file);

    let mut all_cases = Vec::new();

    // Extract cases from each match
    for match_expr in visitor.matches {
        for arm in &match_expr.arms {
            let cases = extract_case_names(&arm.pat);
            all_cases.extend(cases);
        }
    }

    Ok(all_cases)
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
                    Ok(cases) => {
                        results.insert(path, cases);
                    }
                    Err(e) => {
                        eprintln!("Error processing {}: {}", path, e);
                        results.insert(path, Vec::new());
                    }
                }
            }
            Err(e) => {
                eprintln!("Error reading {}: {}", path, e);
                results.insert(path, Vec::new());
            }
        }
    }

    // Output as JSON
    let json = serde_json::to_string(&results)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    println!("{}", json);

    Ok(())
}
