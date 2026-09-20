import axios from "axios";
import path from "path";
import { ReviewResult, ReviewResultSchema, SeverityLevel } from "../types";
import { CallSite } from "./ast";
import { 
  parseFileAstNodes, 
  resolveFindingLineWithTreeSitter,
  extractChangedLinesFromDiff
} from "./treeSitter";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "hermes3";
const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT || "300000", 10); // Default 5 minutes
const MAX_DIFF_LENGTH = parseInt(process.env.MAX_DIFF_LENGTH || "20000", 10);

export function parseAndValidateReviewResponse(rawInput: unknown): ReviewResult {
  let parsed: any;

  if (typeof rawInput === "object" && rawInput !== null) {
    parsed = rawInput;
  } else if (typeof rawInput === "string") {
    let cleanText = rawInput.trim();
    // Strip markdown json codeblock if present
    if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    }
    
    // Attempt standard JSON parse
    try {
      parsed = JSON.parse(cleanText);
    } catch {
      // Attempt to extract JSON object using regex substring
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          parsed = null;
        }
      } else {
        parsed = null;
      }
    }
  }

  // Safe fallback if JSON parsing failed completely
  if (!parsed || typeof parsed !== "object") {
    return {
      summary: "Review output parsed with fallback due to malformed AI output.",
      risk_level: "low",
      breaking_changes: [],
      findings: [],
    };
  }

  // Normalize object keys and string enum cases before Zod validation
  const normalizedFindings = Array.isArray(parsed.findings)
    ? parsed.findings.map((f: any) => {
        const file = typeof f?.file === "string" && f.file.trim().length > 0 ? f.file.trim() : null;
        const line = typeof f?.line === "number" && f.line > 0 ? f.line : typeof f?.line === "string" && !isNaN(parseInt(f.line, 10)) && parseInt(f.line, 10) > 0 ? parseInt(f.line, 10) : null;
        const location = typeof f?.location === "string" && f.location.trim().length > 0
          ? f.location.trim()
          : file && line
          ? `${file}:${line}`
          : file
          ? file
          : null;

        return {
          severity: typeof f?.severity === "string" ? f.severity.toLowerCase().trim() : f?.severity,
          category: typeof f?.category === "string" ? f.category.toLowerCase().trim() : f?.category,
          title: typeof f?.title === "string" ? f.title : "Issue identified",
          file,
          line,
          location,
          description: typeof f?.description === "string" ? f.description : "Potential issue in PR diff",
          evidence: Array.isArray(f?.evidence) ? f.evidence.map(String) : typeof f?.evidence === "string" ? [f.evidence] : [],
          why_it_matters: typeof f?.why_it_matters === "string" ? f.why_it_matters : "May cause runtime errors or security vulnerabilities.",
          suggested_fix: typeof f?.suggested_fix === "string" ? f.suggested_fix : "Review and update implementation.",
          confidence: typeof f?.confidence === "string" ? f.confidence.toLowerCase().trim() : f?.confidence,
        };
      })
    : [];

  const rawNormalized = {
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    risk_level: typeof parsed.risk_level === "string" ? parsed.risk_level.toLowerCase().trim() : "low",
    breaking_changes: Array.isArray(parsed.breaking_changes) ? parsed.breaking_changes.map(String) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : undefined,
    findings: normalizedFindings,
  };

  // Run Zod schema validation
  const zodParsed = ReviewResultSchema.safeParse(rawNormalized);

  let resultData: ReviewResult;
  if (zodParsed.success) {
    resultData = zodParsed.data;
  } else {
    // If Zod validation hit contract errors, log warning and use safe schema defaults
    console.warn("[CLIFF Zod] Schema contract warning:", zodParsed.error.format());
    resultData = {
      summary: rawNormalized.summary || "Review output parsed with fallback.",
      risk_level: "low",
      breaking_changes: rawNormalized.breaking_changes,
      suggestions: rawNormalized.suggestions,
      findings: rawNormalized.findings.map((f: any) => ({
        severity: ["low", "medium", "high", "critical"].includes(f.severity) ? f.severity : "low",
        category: ["security", "correctness", "performance", "maintainability", "testing"].includes(f.category) ? f.category : "correctness",
        title: f.title || "Issue identified",
        file: f.file || null,
        line: f.line || null,
        location: f.file && f.line ? `${f.file}:${f.line}` : f.file || null,
        description: f.description || "Potential issue in PR diff",
        evidence: f.evidence || [],
        why_it_matters: f.why_it_matters || "May cause runtime errors or security vulnerabilities.",
        suggested_fix: f.suggested_fix || "Review and update implementation.",
        confidence: ["low", "medium", "high"].includes(f.confidence) ? f.confidence : "medium",
      })),
    };
  }

  // Calculate dynamic risk_level based on findings
  let computedRisk: SeverityLevel = "low";
  if (resultData.findings.length > 0) {
    if (resultData.findings.some((f) => f.severity === "critical")) {
      computedRisk = "critical";
    } else if (resultData.findings.some((f) => f.severity === "high")) {
      computedRisk = "high";
    } else if (resultData.findings.some((f) => f.severity === "medium")) {
      computedRisk = "medium";
    } else {
      computedRisk = "low";
    }
  } else {
    computedRisk = "low";
  }

  let summary = resultData.summary;
  if (!summary) {
    summary = resultData.findings.length > 0
      ? `Identified ${resultData.findings.length} actionable finding(s) in this PR.`
      : "No high-confidence issues were identified.";
  }

  return {
    ...resultData,
    summary,
    risk_level: computedRisk,
    findings: resultData.findings.map((f) => ({
      ...f,
      location: f.file && f.line ? `${f.file}:${f.line}` : f.file || null,
    })),
  };
}

export async function enrichFindingsWithTreeSitter(
  result: ReviewResult,
  fileContentMap?: Record<string, string>,
  diffText?: string,
): Promise<ReviewResult> {
  if (!result.findings || result.findings.length === 0) {
    return result;
  }

  // Pre-compute changed lines per file from diff for cross-referencing
  const changedLinesMap: Record<string, Set<number>> = {};
  if (diffText) {
    for (const file of Object.keys(fileContentMap || {})) {
      changedLinesMap[file] = extractChangedLinesFromDiff(diffText, file);
    }
  }

  const updatedFindings = await Promise.all(
    result.findings.map(async (finding) => {
      let activeLine = finding.line;
      // finding.file can be null, so check before using as index
      const fileName = finding.file || null;
      const fileContent = fileName ? (fileContentMap?.[fileName] || fileContentMap?.[path.basename(fileName)]) : undefined;
      const changedLines = fileName ? (changedLinesMap[fileName] || changedLinesMap[path.basename(fileName)]) : undefined;

      // Always validate the line (even if LLM provided one) against evidence
      if (fileName && fileContent) {
        // First, check if the current line actually contains relevant evidence
        const lineIsValid = activeLine && activeLine > 0 && activeLine <= fileContent.split("\n").length
          ? fileContent.split("\n")[activeLine - 1].length > 0
          : false;

        // If line is invalid or we want to verify it, try to resolve
        if (!lineIsValid || activeLine === null || activeLine === undefined) {
          const resolvedLine = await resolveFindingLineWithTreeSitter(
            fileName,
            fileContent,
            finding.evidence,
            finding.title,
            changedLines,
          );
          if (resolvedLine) {
            activeLine = resolvedLine;
          }
        } else {
          // Even if line exists, verify it matches evidence - if not, try to find better line
          const lineContent = fileContent.split("\n")[activeLine - 1];
          const tokens = extractSearchTokensFromEvidence(finding.evidence);
          const hasMatchingToken = tokens.some(t => lineContent.includes(t));
          
          if (!hasMatchingToken && tokens.length > 0) {
            console.log(`[CLIFF Tree-sitter] LLM line ${activeLine} doesn't match evidence, attempting re-resolution`);
            const resolvedLine = await resolveFindingLineWithTreeSitter(
              fileName,
              fileContent,
              finding.evidence,
              finding.title,
              changedLines,
            );
            if (resolvedLine && resolvedLine !== activeLine) {
              console.log(`[CLIFF Tree-sitter] Corrected line from ${activeLine} to ${resolvedLine}`);
              activeLine = resolvedLine;
            }
          }
        }
      }

      const location = fileName && activeLine ? `${fileName}:${activeLine}` : fileName || null;
      return {
        ...finding,
        line: activeLine,
        location,
      };
    }),
  );

  return {
    ...result,
    findings: updatedFindings,
  };
}

// Helper to extract tokens from evidence (mirror of treeSitter's extractSearchTokens)
function extractSearchTokensFromEvidence(evidenceSnippets: string[]): string[] {
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

    const blocks = clean.split(/\s*\.\.\.+\s*/);

    for (const block of blocks) {
      const b = block.trim();
      if (!b) continue;

      const callMatches = b.matchAll(/[\w.]+\s*\([^)]*\)/g);
      for (const m of callMatches) add(m[0]);

      const assignMatches = b.matchAll(/\b\w+\s*=\s*[^\s=][^\n]*/g);
      for (const m of assignMatches) add(m[0].trim());

      const decoratorMatches = b.matchAll(/@[\w.]+(?:\([^)]*\))?/g);
      for (const m of decoratorMatches) add(m[0]);

      const withMatches = b.matchAll(/\bwith\s+\w[^\n]*/g);
      for (const m of withMatches) add(m[0].trim());

      const importMatches = b.matchAll(/(?:import|from)\s+[\w.]+[^\n]*/g);
      for (const m of importMatches) add(m[0].trim());

      add(b);
    }
  }

  return tokens.sort((a, b) => b.length - a.length);
}

export async function runHermesAnalysis(
  diffText: string,
  prTitle: string,
  dominoSites: CallSite[] = [],
  fileContentMap?: Record<string, string>,
): Promise<ReviewResult> {
  const safeDiffText = diffText.length > MAX_DIFF_LENGTH
    ? `${diffText.slice(0, MAX_DIFF_LENGTH)}\n... [PR Diff truncated for LLM context length]`
    : diffText;

  const dominoContext = dominoSites.length
    ? dominoSites
        .map(
          (site) =>
            `- File: ${site.callerFile} (Line ${site.line})\n  Call Site: \`${site.snippet}\``,
        )
        .join("\n")
    : "No downstream call sites detected.";

  let treeSitterContext = "";
  if (fileContentMap) {
    const nodeSummaries: string[] = [];
    for (const [file, content] of Object.entries(fileContentMap)) {
      const nodes = await parseFileAstNodes(file, content);
      if (nodes.length > 0) {
        const nodeStr = nodes
          .slice(0, 10)
          .map((n) => `  * [${n.type}] (Lines ${n.startLine}-${n.endLine}): \`${n.snippet}\``)
          .join("\n");
        nodeSummaries.push(`File: ${file}\n${nodeStr}`);
      }
    }
    if (nodeSummaries.length > 0) {
      treeSitterContext = `\n=== TREE-SITTER REPOSITORY CODE NODES ===\n${nodeSummaries.join("\n\n")}\n`;
    }
  }

  const prompt = `You are an expert, evidence-based AI Code Reviewer. Analyze the PR diff below for concrete issues (prioritizing security and correctness).

PR Title: ${prTitle}

=== PRIMARY PR DIFF ===
${safeDiffText}

=== POTENTIAL DOWNSTREAM CALL SITES AT RISK ===
${dominoContext}
${treeSitterContext}
RULES FOR YOUR REVIEW:
1. HIGH SIGNAL ONLY: Every finding MUST contain concrete evidence directly observed from the PR diff or context.
2. DO NOT FORCE FINDINGS: If the PR is clean or has no high-confidence vulnerabilities/bugs, return an empty "findings" array ("findings": []), "risk_level": "low", and summary "No high-confidence issues were identified."
3. ELIMINATE GENERIC ADVICE: Do NOT provide generic suggestions such as "Add error handling", "Validate input", or "Test thoroughly" unless supported by direct evidence in the PR.
4. EVIDENCE TRACING: For vulnerabilities or bugs, trace:
   SOURCE -> DATA FLOW -> SINK -> MISSING/INSUFFICIENT VALIDATION -> IMPACT
   Example for SQL Injection: User-controlled parameter is directly interpolated into SQL query string passed to cursor.execute().
5. FILE AND LINE NUMBERS: Specify exact file path and line number for findings. If exact line cannot be determined reliably, set "line": null (do NOT invent or hallucinate line numbers).
6. CONFIDENCE: Set confidence to "low", "medium", or "high" based on how strongly repository evidence supports the finding.

Return ONLY a valid JSON object matching this schema:
{
  "summary": "Short concise summary of the PR and overall finding evaluation",
  "risk_level": "low | medium | high | critical",
  "breaking_changes": ["affected symbol or breaking API change"],
  "findings": [
    {
      "severity": "low | medium | high | critical",
      "category": "security | correctness | performance | maintainability | testing",
      "title": "Short title of issue",
      "file": "path/to/file.ext",
      "line": 42,
      "description": "What is wrong in detail",
      "evidence": [
        "Concrete code snippet or parameter flow showing the issue"
      ],
      "why_it_matters": "Technical impact of this flaw",
      "suggested_fix": "Specific actionable fix (include diff snippet if appropriate)",
      "confidence": "low | medium | high"
    }
  ]
}`;

  try {
    console.log(`[CLIFF] Sending request to Ollama (${OLLAMA_MODEL}) with timeout ${OLLAMA_TIMEOUT}ms...`);
    const response = await axios.post(
      OLLAMA_URL,
      {
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json",
        keep_alive: "30m",
        options: {
          num_predict: 2048,
          temperature: 0.1,
        },
      },
      { timeout: OLLAMA_TIMEOUT },
    );

    const rawResponse = response.data?.response;
    const parsedResult = parseAndValidateReviewResponse(rawResponse);
    return enrichFindingsWithTreeSitter(parsedResult, fileContentMap, diffText);
  } catch (error: any) {
    if (error?.code === "ECONNABORTED") {
      console.error(
        `[CLIFF] Ollama timeout (${OLLAMA_TIMEOUT}ms exceeded). Model '${OLLAMA_MODEL}' was slow to generate output.`,
      );
    } else {
      console.error("[CLIFF] Hermes API error:", error?.message || error);
    }
    // Controlled fallback on error, never crash
    return {
      summary: `Failed to complete AI analysis (${error?.code === "ECONNABORTED" ? "Timeout: local model generation took longer than configured limit" : "Service error"}).`,
      risk_level: "low",
      breaking_changes: [],
      findings: [],
    };
  }
}



