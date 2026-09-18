import axios from "axios";
import { ReviewResult, Finding, SeverityLevel, FindingCategory, ConfidenceLevel } from "../types";
import { CallSite } from "./ast";

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

  const validSeverities: SeverityLevel[] = ["low", "medium", "high", "critical"];
  const validCategories: FindingCategory[] = ["security", "correctness", "performance", "maintainability", "testing"];
  const validConfidences: ConfidenceLevel[] = ["low", "medium", "high"];

  // Sanitize findings array
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings: Finding[] = rawFindings.map((f: any) => {
    const rawSev = String(f?.severity || "").toLowerCase() as SeverityLevel;
    const severity: SeverityLevel = validSeverities.includes(rawSev) ? rawSev : "low";

    const rawCat = String(f?.category || "").toLowerCase() as FindingCategory;
    const category: FindingCategory = validCategories.includes(rawCat) ? rawCat : "correctness";

    const rawConf = String(f?.confidence || "").toLowerCase() as ConfidenceLevel;
    const confidence: ConfidenceLevel = validConfidences.includes(rawConf) ? rawConf : "medium";

    let line: number | null = null;
    if (typeof f?.line === "number" && !isNaN(f.line) && f.line > 0) {
      line = f.line;
    } else if (typeof f?.line === "string" && !isNaN(parseInt(f.line, 10))) {
      const parsedLine = parseInt(f.line, 10);
      if (parsedLine > 0) line = parsedLine;
    }

    const file = typeof f?.file === "string" && f.file.trim().length > 0 ? f.file.trim() : null;

    const evidence = Array.isArray(f?.evidence)
      ? f.evidence.map((e: any) => String(e))
      : typeof f?.evidence === "string"
      ? [f.evidence]
      : [];

    return {
      severity,
      category,
      title: String(f?.title || "Issue identified"),
      file,
      line,
      description: String(f?.description || "Potential issue in PR diff"),
      evidence,
      why_it_matters: String(f?.why_it_matters || "May cause runtime errors or security vulnerabilities."),
      suggested_fix: String(f?.suggested_fix || "Review and update implementation."),
      confidence,
    };
  });

  // Calculate dynamic risk_level based on findings
  let computedRisk: SeverityLevel = "low";
  if (findings.length > 0) {
    if (findings.some((f) => f.severity === "critical")) {
      computedRisk = "critical";
    } else if (findings.some((f) => f.severity === "high")) {
      computedRisk = "high";
    } else if (findings.some((f) => f.severity === "medium")) {
      computedRisk = "medium";
    } else {
      computedRisk = "low";
    }
  } else {
    computedRisk = "low";
  }

  // Summary
  let summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "";
  if (!summary) {
    summary = findings.length > 0
      ? `Identified ${findings.length} actionable finding(s) in this PR.`
      : "No high-confidence issues were identified.";
  }

  // Breaking changes
  const breaking_changes = Array.isArray(parsed.breaking_changes)
    ? parsed.breaking_changes.map((b: any) => String(b))
    : [];

  const result: ReviewResult = {
    summary,
    risk_level: computedRisk,
    breaking_changes,
    findings,
  };

  if (Array.isArray(parsed.suggestions)) {
    result.suggestions = parsed.suggestions.map((s: any) => String(s));
  }

  return result;
}

export async function runHermesAnalysis(
  diffText: string,
  prTitle: string,
  dominoSites: CallSite[] = [],
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

  const prompt = `You are an expert, evidence-based AI Code Reviewer. Analyze the PR diff below for concrete issues (prioritizing security and correctness).

PR Title: ${prTitle}

=== PRIMARY PR DIFF ===
${safeDiffText}

=== POTENTIAL DOWNSTREAM CALL SITES AT RISK ===
${dominoContext}

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
    return parseAndValidateReviewResponse(rawResponse);
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


