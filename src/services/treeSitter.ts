import path from "path";
import fs from "fs";
import Parser from "web-tree-sitter";

let isParserInitialized = false;
const loadedLanguages: Map<string, Parser.Language> = new Map();

export interface AstCodeNode {
  type: string;
  name?: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface LineCandidate {
  line: number;
  score: number;
  matchedTokens: string[];
  nodeType?: string;
}

const EXTENSION_TO_WASM: Record<string, string> = {
  ".py": "tree-sitter-python.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".go": "tree-sitter-go.wasm",
  ".java": "tree-sitter-java.wasm",
  ".c": "tree-sitter-c.wasm",
  ".cpp": "tree-sitter-cpp.wasm",
  ".cc": "tree-sitter-cpp.wasm",
  ".h": "tree-sitter-c.wasm",
  ".php": "tree-sitter-php.wasm",
  ".rb": "tree-sitter-ruby.wasm",
  ".rs": "tree-sitter-rust.wasm",
};

// Security-relevant sink node types across languages
const SINK_NODE_TYPES = new Set([
  "call_expression",
  "call",
  "invocation",
  "function_call",
  "method_invocation",
  "await_expression",
  "exec",
  "execute",
  "query",
  "raw",
  "send",
  "write",
  "render",
  "eval",
  "system",
  "popen",
  "subprocess",
]);

// Source node types (user input entry points)
const SOURCE_NODE_TYPES = new Set([
  "parameter",
  "argument",
  "identifier",
  "attribute",
  "subscript",
  "subscription",
  "request",
  "params",
  "query",
  "body",
  "input",
  "argv",
  "environ",
  "getenv",
]);

async function ensureParserInit(): Promise<void> {
  if (!isParserInitialized) {
    await Parser.init();
    isParserInitialized = true;
  }
}

async function getLanguageForFile(filePath: string): Promise<Parser.Language | null> {
  await ensureParserInit();
  const ext = path.extname(filePath).toLowerCase();
  const wasmFileName = EXTENSION_TO_WASM[ext];
  if (!wasmFileName) return null;

  if (loadedLanguages.has(wasmFileName)) {
    return loadedLanguages.get(wasmFileName)!;
  }

  const possiblePaths = [
    path.resolve(process.cwd(), "node_modules/tree-sitter-wasms/out", wasmFileName),
    path.resolve(__dirname, "../node_modules/tree-sitter-wasms/out", wasmFileName),
    path.resolve(__dirname, "../../node_modules/tree-sitter-wasms/out", wasmFileName),
  ];

  let wasmPath: string | null = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      wasmPath = p;
      break;
    }
  }

  if (!wasmPath) {
    console.warn(`[CLIFF Tree-sitter] WASM file for ${wasmFileName} not found in search paths.`);
    return null;
  }

  try {
    const lang = await Parser.Language.load(wasmPath);
    loadedLanguages.set(wasmFileName, lang);
    return lang;
  } catch (err) {
    console.warn(`[CLIFF Tree-sitter] Failed to load WASM for ${wasmFileName}:`, err);
    return null;
  }
}

export async function parseFileAstNodes(filePath: string, fileContent: string): Promise<AstCodeNode[]> {
  const lang = await getLanguageForFile(filePath);
  if (!lang) return [];

  const parser = new Parser();
  parser.setLanguage(lang);

  const tree = parser.parse(fileContent);
  const nodes: AstCodeNode[] = [];

  function walk(node: Parser.SyntaxNode) {
    const type = node.type;
    const isTargetNode =
      type.includes("function") ||
      type.includes("class") ||
      type.includes("decorated") ||
      type.includes("call") ||
      type.includes("method") ||
      type.includes("assignment") ||
      type.includes("declaration");

    if (isTargetNode) {
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const firstLine = node.text.split("\n")[0].trim();

      nodes.push({
        type,
        startLine,
        endLine,
        snippet: firstLine.length > 100 ? firstLine.slice(0, 97) + "..." : firstLine,
      });
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return nodes;
}

/**
 * Extracts changed line numbers from a unified diff for a specific file.
 * Returns a Set of line numbers that were added/modified in the new file version.
 */
export function extractChangedLinesFromDiff(diffText: string, targetFile: string): Set<number> {
  const lines = diffText.split("\n");
  const changedLines = new Set<number>();
  let currentFile: string | null = null;
  let newLineNum = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      inHunk = false;
      continue;
    }

    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) {
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentFile) continue;

    // Normalize file path for comparison
    const normalizedCurrent = currentFile.replace(/^.*\/([^\/]+)$/, "$1");
    const normalizedTarget = targetFile.replace(/^.*\/([^\/]+)$/, "$1");
    if (normalizedCurrent !== normalizedTarget && currentFile !== targetFile) continue;

    if (line.startsWith("+")) {
      changedLines.add(newLineNum);
      newLineNum++;
    } else if (line.startsWith("-")) {
      // Removed line - doesn't exist in new file
    } else if (line.startsWith("\\")) {
      // No newline at end of file
    } else {
      // Context line
      newLineNum++;
    }
  }

  return changedLines;
}

function isSinkNodeType(nodeType: string): boolean {
  const lower = nodeType.toLowerCase();
  for (const sink of SINK_NODE_TYPES) {
    if (lower.includes(sink)) return true;
  }
  return false;
}

function isSourceNodeType(nodeType: string): boolean {
  const lower = nodeType.toLowerCase();
  for (const source of SOURCE_NODE_TYPES) {
    if (lower.includes(source)) return true;
  }
  return false;
}

/**
 * Scores a line candidate based on multiple evidence tokens.
 * Higher score = more confident match.
 */
function scoreLineCandidate(
  line: number,
  lineContent: string,
  tokens: string[],
  nodeType?: string
): number {
  let score = 0;
  let matchedCount = 0;

  for (const token of tokens) {
    if (lineContent.includes(token)) {
      matchedCount++;
      // Longer tokens are more specific
      score += token.length * 2;
    }
  }

  // Bonus for matching multiple tokens
  if (matchedCount > 1) {
    score += matchedCount * 10;
  }

  // Bonus for sink node types (where vulnerabilities typically manifest)
  if (nodeType && isSinkNodeType(nodeType)) {
    score += 50;
  }

  // Bonus for source node types (where user input enters)
  if (nodeType && isSourceNodeType(nodeType)) {
    score += 30;
  }

  return score;
}

export async function resolveFindingLineWithTreeSitter(
  filePath: string,
  fileContent: string,
  evidenceSnippets: string[] = [],
  title: string = "",
  changedLines?: Set<number>,
): Promise<number | null> {
  // 1. First try: Validate LLM-provided line if we had one (handled by caller)
  // 2. Token-based text search with scoring
  const textResult = tokenBasedLineSearch(fileContent, evidenceSnippets, title, changedLines);
  if (textResult !== null) {
    console.log(`[CLIFF Tree-sitter] Resolved via scored text search: ${filePath}:${textResult}`);
    return textResult;
  }

  // 3. AST-based resolution with node type awareness
  const lang = await getLanguageForFile(filePath);
  if (!lang) {
    return null;
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(fileContent);

  const tokens = extractSearchTokens(evidenceSnippets);
  const candidates: LineCandidate[] = [];

  function walk(node: Parser.SyntaxNode) {
    const nodeText = node.text;
    const nodeLine = node.startPosition.row + 1;
    const nodeType = node.type;

    // Check if this node contains any of our search tokens
    for (const token of tokens) {
      if (nodeText.includes(token)) {
        // Found a match - check if this is a more specific (deeper) node
        const existing = candidates.find(c => c.line === nodeLine);
        const score = scoreLineCandidate(nodeLine, nodeText, tokens, nodeType);
        
        if (!existing || score > existing.score) {
          if (existing) {
            const idx = candidates.indexOf(existing);
            candidates[idx] = { line: nodeLine, score, matchedTokens: [token], nodeType };
          } else {
            candidates.push({ line: nodeLine, score, matchedTokens: [token], nodeType });
          }
        } else if (existing) {
          // Add token to existing candidate's matched tokens
          if (!existing.matchedTokens.includes(token)) {
            existing.matchedTokens.push(token);
            existing.score += token.length;
          }
        }
      }
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);

  // Filter by changed lines if provided
  let filteredCandidates = candidates;
  if (changedLines && changedLines.size > 0) {
    filteredCandidates = candidates.filter(c => changedLines.has(c.line));
    if (filteredCandidates.length === 0) {
      console.log(`[CLIFF Tree-sitter] No candidates in changed lines, falling back to all candidates`);
      filteredCandidates = candidates;
    }
  }

  // Sort by score descending
  filteredCandidates.sort((a, b) => b.score - a.score);

  if (filteredCandidates.length > 0) {
    const best = filteredCandidates[0];
    console.log(`[CLIFF Tree-sitter] Resolved via AST walk (score=${best.score}, tokens=${best.matchedTokens.join(",")}, nodeType=${best.nodeType}): ${filePath}:${best.line}`);
    return best.line;
  }

  return null;
}

/**
 * Extracts individual searchable code tokens from LLM evidence snippets.
 *
 * LLM evidence is often space-joined condensed code:
 *   "@app.route('/user') def get_user(): username = ... cursor.execute(query)"
 *
 * Strategy (ordered by specificity):
 * 1. Split on "..." to get before/after blocks
 * 2. From each block, extract function calls: word(...)
 * 3. Extract assignment statements: x = ...
 * 4. Extract decorator lines: @word
 * 5. Fall back to any token >= 8 chars
 */
function extractSearchTokens(evidenceSnippets: string[]): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  function add(t: string) {
    const s = t.trim();
    if (s.length >= 5 && !seen.has(s)) {
      seen.add(s);
      tokens.push(s);
    }
  }

  for (const raw of evidenceSnippets) {
    const clean = raw.replace(/^[`"']|[`"']$/g, "").trim();
    if (!clean) continue;

    // 1. Split on "..." separators
    const blocks = clean.split(/\s*\.\.\.+\s*/);

    for (const block of blocks) {
      const b = block.trim();
      if (!b) continue;

      // 2. Extract function/method calls: identifier(...)
      const callMatches = b.matchAll(/[\w.]+\s*\([^)]*\)/g);
      for (const m of callMatches) add(m[0]);

      // 3. Extract assignment RHS: word = <expr>
      const assignMatches = b.matchAll(/\b\w+\s*=\s*[^\s=][^\n]*/g);
      for (const m of assignMatches) add(m[0].trim());

      // 4. Extract decorator lines: @word
      const decoratorMatches = b.matchAll(/@[\w.]+(?:\([^)]*\))?/g);
      for (const m of decoratorMatches) add(m[0]);

      // 5. Extract "with open(..." style context managers
      const withMatches = b.matchAll(/\bwith\s+\w[^\n]*/g);
      for (const m of withMatches) add(m[0].trim());

      // 6. Extract import/from lines
      const importMatches = b.matchAll(/(?:import|from)\s+[\w.]+[^\n]*/g);
      for (const m of importMatches) add(m[0].trim());

      // 7. Add the entire block as a candidate too
      add(b);
    }
  }

  // Sort: longest tokens first (more specific = better)
  return tokens.sort((a, b) => b.length - a.length);
}


/**
 * Fast per-line text search with token-aware scoring.
 * Tries each extracted token against each source line.
 * Returns the 1-based line number of the best (highest scoring) match.
 */
function tokenBasedLineSearch(
  fileContent: string,
  evidenceSnippets: string[] = [],
  title: string = "",
  changedLines?: Set<number>,
): number | null {
  const lines = fileContent.split("\n");
  const tokens = extractSearchTokens(evidenceSnippets);

  const candidates: { line: number; score: number }[] = [];

  // Try each token against each line
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    
    // If we have changed lines, only consider those (but don't filter too aggressively)
    if (changedLines && changedLines.size > 0 && !changedLines.has(lineNum)) {
      continue;
    }

    const lineContent = lines[i];
    let lineScore = 0;
    let matchedTokens = 0;

    for (const token of tokens) {
      if (lineContent.includes(token)) {
        matchedTokens++;
        lineScore += token.length * 2;
      }
    }

    // Bonus for multiple token matches on same line
    if (matchedTokens > 1) {
      lineScore += matchedTokens * 10;
    }

    if (lineScore > 0) {
      candidates.push({ line: lineNum, score: lineScore });
    }
  }

  // Also try title-based matching as fallback
  if (candidates.length === 0 && title) {
    const stopWords = new Set(["vulnerability", "issue", "bug", "error", "the", "and", "for", "in", "of", "a", "an"]);
    const titleWords = title.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !stopWords.has(w));

    for (const word of titleWords) {
      for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        if (changedLines && changedLines.size > 0 && !changedLines.has(lineNum)) continue;
        
        if (lines[i].toLowerCase().includes(word)) {
          candidates.push({ line: lineNum, score: 5 });
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].line;
}

