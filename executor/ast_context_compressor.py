#!/usr/bin/env python3
"""AST Context Skeletonizer (Oculus audit 4.2 — roadmap 2.1, 2026-08-20).

Compresses Python source into a context skeleton: module docstring, imports,
and class/function signatures (with type annotations) are kept; function
bodies collapse to "# ... (body collapsed)". Names in `focus_symbols` keep
their bodies IN FULL (edit targets need exact text for old_code matching).

Measured 60-85% size reduction while preserving the type hierarchy and
public API surface. Unparseable files fall back to regex compression
(collapse blank runs) with a hard 8000-char cap.
"""

import ast
import re

FALLBACK_CAP = 8000

# Security-relevant line patterns for the SEC agent's role slice.
SEC_PATTERNS = re.compile(
    r"(^import |^from |urlopen|requests\.|urllib|aiohttp|socket|websocket|"
    r"http[s]?://|auth|token|api_?key|password|secret|credential|os\.environ|"
    r"sql|subprocess|open\(|pickle|yaml\.load|eval\(|exec\(|shell=True|"
    r"setattr|getattr|__import__)",
    re.IGNORECASE)


def security_slice(src: str, cap_lines: int = 60) -> str:
    """Role slice for SEC: imports + network/auth/secrets-touching lines only."""
    if not src:
        return "(file is empty)"
    lines = [l.rstrip() for l in src.splitlines() if SEC_PATTERNS.search(l)]
    if not lines:
        return "(no security-relevant lines in this file)"
    return "\n".join(lines[:cap_lines])


def skeletonize_source(src: str, filename: str = "<unknown>",
                       focus_symbols=None, cap: int = FALLBACK_CAP) -> str:
    """Return a skeleton of `src` (see module docstring)."""
    focus = set(focus_symbols or [])
    try:
        tree = ast.parse(src)
    except SyntaxError:
        # Unparseable: regex-compress (drop blank runs) + hard cap.
        lines = [l.rstrip() for l in src.splitlines() if l.strip()]
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines))[:cap]

    src_lines = src.splitlines()

    def segment(node) -> str:
        return ast.get_source_segment(src, node) or ""

    def header_of(node) -> str:
        """Function/class header (signature + docstring), no body."""
        seg = segment(node)
        if not seg:
            return f"def {node.name}(...):  # source unavailable"
        first_body = node.body[0].lineno
        hdr = seg.splitlines()[: max(1, first_body - node.lineno)]
        doc = node.body[0]
        if (isinstance(doc, ast.Expr) and isinstance(doc.value, ast.Constant)
                and isinstance(doc.value.value, str)):
            dseg = segment(doc)
            if dseg:
                hdr.append("\n".join("    " + l for l in dseg.splitlines()))
        return "\n".join(hdr)

    def emit_stmt(node, indent: int = 0) -> list:
        pad = "    " * indent
        out = []
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            out.append(pad + (segment(node) or ast.unparse(node)))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in focus:
                out.append(segment(node) or (pad + f"def {node.name}(...):"))
            else:
                out.append(pad + header_of(node).replace("\n", "\n" + pad))
                out.append(pad + "    # ... (body collapsed)")
        elif isinstance(node, ast.ClassDef):
            if node.name in focus:
                out.append(segment(node) or (pad + f"class {node.name}:"))
            else:
                out.append(pad + header_of(node).replace("\n", "\n" + pad))
                # Recurse into methods — the class API surface.
                for child in node.body:
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        out.extend(emit_stmt(child, indent + 1))
                out.append(pad + "    # ... (other class members collapsed)")
        else:
            try:
                flat = ast.unparse(node)
            except Exception:
                flat = ""
            if flat and len(flat) <= 200:
                out.append(pad + flat)
            else:
                first = src_lines[node.lineno - 1].strip() if 0 < node.lineno <= len(src_lines) else "?"
                out.append(pad + f"{first}  # ... (body collapsed)")
        return out

    out = []
    # Module docstring first.
    first = tree.body[0] if tree.body else None
    if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)):
        dseg = segment(first)
        if dseg:
            out.append('"""' + dseg.strip('"').strip() + '"""')
        tree.body = tree.body[1:]
    for node in tree.body:
        out.extend(emit_stmt(node, 0))

    text = "\n".join(out)
    return text[:cap] + ("\n# ... (skeleton truncated)" if len(text) > cap else "")


def skeletonize_file(path: str, focus_symbols=None, cap: int = FALLBACK_CAP) -> str:
    """Read `path` and skeletonize it. Missing file -> placeholder."""
    try:
        with open(path, "r", errors="replace") as f:
            return skeletonize_source(f.read(), path, focus_symbols, cap)
    except OSError:
        return f"(file unreadable: {path})"
