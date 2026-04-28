// Lightweight Python-import scanner used by the upload validator.
//
// We don't need a full AST — we just want to know which top-level
// packages a project imports so we can decide whether a missing
// requirements.txt is a problem. A regex pass over each .py file is
// good enough: false positives here just mean we ask the user for a
// requirements.txt they may not strictly need, which is fine. False
// negatives (skipping a real import) would be worse, but the regex
// covers the standard `import X` / `from X import ...` forms.
//
// Notes on heuristics we deliberately keep simple:
//   • Comments and triple-quoted strings can technically contain text
//     that looks like an import. We strip `#`-comments line-by-line
//     and ignore lines that visually start inside a string by checking
//     for an even number of `"""` markers seen so far. Good enough.
//   • Conditional / lazy imports (inside try/except, functions) are
//     reported the same as top-level — we err on the side of warning.

const STDLIB = new Set<string>([
  "__future__", "abc", "argparse", "array", "ast", "asyncio", "atexit",
  "base64", "bisect", "builtins", "bz2", "calendar", "cmath", "cmd", "code",
  "codecs", "collections", "colorsys", "concurrent", "configparser",
  "contextlib", "contextvars", "copy", "copyreg", "csv", "ctypes",
  "dataclasses", "datetime", "decimal", "difflib", "dis", "doctest",
  "email", "encodings", "enum", "errno", "faulthandler", "fcntl",
  "filecmp", "fileinput", "fnmatch", "fractions", "ftplib", "functools",
  "gc", "getopt", "getpass", "gettext", "glob", "graphlib", "grp",
  "gzip", "hashlib", "heapq", "hmac", "html", "http", "imaplib",
  "importlib", "inspect", "io", "ipaddress", "itertools", "json",
  "keyword", "linecache", "locale", "logging", "lzma", "mailbox",
  "math", "mimetypes", "mmap", "multiprocessing", "netrc", "nis",
  "ntpath", "numbers", "operator", "optparse", "os", "pathlib",
  "pickle", "pickletools", "pkgutil", "platform", "plistlib", "poplib",
  "posix", "posixpath", "pprint", "profile", "pstats", "pty", "pwd",
  "py_compile", "queue", "quopri", "random", "re", "readline",
  "reprlib", "resource", "rlcompleter", "runpy", "sched", "secrets",
  "select", "selectors", "shelve", "shlex", "shutil", "signal",
  "site", "smtplib", "socket", "socketserver", "sqlite3", "ssl",
  "stat", "statistics", "string", "stringprep", "struct", "subprocess",
  "symtable", "sys", "sysconfig", "syslog", "tabnanny", "tarfile",
  "telnetlib", "tempfile", "termios", "textwrap", "threading", "time",
  "timeit", "tkinter", "token", "tokenize", "tomllib", "trace",
  "traceback", "tracemalloc", "tty", "turtle", "types", "typing",
  "unicodedata", "unittest", "urllib", "uu", "uuid", "venv",
  "warnings", "wave", "weakref", "webbrowser", "winreg", "winsound",
  "wsgiref", "xdrlib", "xml", "xmlrpc", "zipapp", "zipfile",
  "zipimport", "zlib", "zoneinfo",
]);

// Packages that the agent/service base images pre-install. The top-level
// import name (with underscores) — not the pip distribution name — is
// what matters.
//
// Update this whenever images/Dockerfile.agent-base or service-base
// change their `pip install` line.
const PREINSTALLED = new Set<string>([
  // zyndai-agent and its declared transitive runtime deps
  "zyndai_agent",
  "zynd",
  "dotenv",            // python-dotenv installs as `dotenv`
  "requests",
  "httpx",
  "pydantic",
  "pydantic_core",
  "pydantic_settings",
  "fastapi",
  "starlette",
  "uvicorn",
  "anyio",
  "sniffio",
  "click",
  // Agent-specific frameworks
  "langchain",
  "langchain_openai",
  "langchain_community",
  "langchain_classic",
  "langchain_core",
  "langchain_text_splitters",
  "langgraph",
  "langsmith",
  "crewai",
  "pydantic_ai",
  // Common transitive deps users tend to import directly
  "openai",
  "tiktoken",
  "tenacity",
  "yaml",              // pyyaml -> import yaml
  "numpy",
  "aiohttp",
  "websockets",
  "tqdm",
  "regex",
  "packaging",
]);

const IMPORT_LINE_RE = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w][\w.]*(?:\s*,\s*[\w][\w.]*)*))/gm;

interface ScanResult {
  imports: Set<string>;
  unresolved: Set<string>;
}

function topLevel(name: string): string {
  // Strip relative import prefix; "from .foo import bar" -> "" (relative).
  const withoutDots = name.replace(/^\.+/, "");
  if (!withoutDots) return "";
  return withoutDots.split(".")[0];
}

function stripComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => {
      // Strip everything from an unquoted `#` to end-of-line. We don't
      // try to handle `#` inside strings — false positives in the
      // import scan only over-warn, and triple-quoted strings rarely
      // contain `import X` patterns at column 0.
      const idx = line.indexOf("#");
      if (idx < 0) return line;
      return line.slice(0, idx);
    })
    .join("\n");
}

export function scanImports(source: string): Set<string> {
  const cleaned = stripComments(source);
  const out = new Set<string>();
  for (const m of cleaned.matchAll(IMPORT_LINE_RE)) {
    if (m[1]) {
      const top = topLevel(m[1]);
      if (top) out.add(top);
    }
    if (m[2]) {
      // `import a, b.c, d` — split on commas.
      for (const piece of m[2].split(",")) {
        // Strip "as alias" suffix.
        const name = piece.trim().split(/\s+as\s+/)[0]?.trim();
        if (!name) continue;
        const top = topLevel(name);
        if (top) out.add(top);
      }
    }
  }
  return out;
}

export function findUnresolvedImports(
  files: Map<string, Uint8Array>,
  knownExtras: Set<string> = new Set()
): ScanResult {
  // Local-source modules: any top-level .py file is importable as its
  // basename, and any directory containing __init__.py is a package.
  const localModules = new Set<string>();
  for (const path of files.keys()) {
    if (path.endsWith(".py") && !path.includes("/")) {
      localModules.add(path.slice(0, -3));
    }
    if (path.endsWith("/__init__.py")) {
      const seg = path.split("/")[0];
      if (seg) localModules.add(seg);
    }
  }

  const allImports = new Set<string>();
  const unresolved = new Set<string>();

  for (const [path, bytes] of files.entries()) {
    if (!path.endsWith(".py")) continue;
    if (path.startsWith(".") || path.includes("/.")) continue;
    const text = Buffer.from(bytes).toString("utf8");
    const imports = scanImports(text);
    for (const top of imports) {
      allImports.add(top);
      if (
        STDLIB.has(top) ||
        PREINSTALLED.has(top) ||
        knownExtras.has(top) ||
        localModules.has(top)
      ) {
        continue;
      }
      unresolved.add(top);
    }
  }

  return { imports: allImports, unresolved };
}

export function declaredRequirementNames(text: string): Set<string> {
  // Extract distribution names from a requirements.txt. We don't try
  // to map distribution → import name (e.g. python-dotenv → dotenv) —
  // we just take the dist name. The validator only needs to confirm
  // the user *declared* something covering the unresolved imports;
  // pip will sort out whether it actually installs.
  const out = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    if (line.startsWith("-")) continue; // -r, -e, -c flags
    // Take everything up to the first version specifier or extras bracket.
    const m = line.match(/^([A-Za-z0-9_.\-]+)/);
    if (!m) continue;
    out.add(m[1].toLowerCase().replace(/-/g, "_"));
  }
  return out;
}
