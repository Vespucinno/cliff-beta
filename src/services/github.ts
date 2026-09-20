import axios from "axios";
import { ReviewResult, Finding, SeverityLevel } from "../types";
import { extractChangedLinesFromDiff } from "./treeSitter";

export async function getPrDiff(
  diffUrl: string,
  token?: string,
): Promise<string> {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await axios.get<string>(diffUrl, {
    headers,
    responseType: "text",
  });
  return response.data;
}

/**
 * Parses a unified diff string and returns a map of:
 *   { "path/to/file.py": <reconstructed file content with correct line numbers> }
 *
 * Uses a line-by-line state machine — more reliable than regex for
 * single-hunk files, multi-hunk files, and GitHub's diff format.
 */
export function extractFileContentsFromDiff(diffText: string): Record<string, string> {
  const fileMap: Record<string, string> = {};
  const lines = diffText.split("\n");

  let currentFile: string | null = null;
  let lineMap: Map<number, string> = new Map();
  let newLineNum = 0;
  let inHunk = false;

  const flushFile = () => {
    if (currentFile && lineMap.size > 0) {
      const maxLine = Math.max(...lineMap.keys());
      const arr: string[] = new Array(maxLine + 1).fill("");
      for (const [ln, content] of lineMap) arr[ln] = content;
      fileMap[currentFile] = arr.slice(1).join("\n");
      console.log(`[CLIFF Diff] Parsed ${lineMap.size} lines for ${currentFile}`);
    }
    lineMap = new Map();
    inHunk = false;
    newLineNum = 0;
  };

  for (const line of lines) {
    // New file section
    if (line.startsWith("diff --git ")) {
      flushFile();
      currentFile = null;
      continue;
    }

    // Extract b/ filename
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      continue;
    }

    // Skip deleted file marker and metadata
    if (line.startsWith("--- ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) {
      continue;
    }

    // Hunk header: @@ -old,n +newStart,n @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineNum = parseInt(hunkMatch[1], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentFile) continue;

    if (line.startsWith("+")) {
      // Added line
      lineMap.set(newLineNum, line.slice(1));
      newLineNum++;
    } else if (line.startsWith("-")) {
      // Removed line — skip (doesn't exist in new file)
    } else if (line.startsWith("\\")) {
      // "No newline at end of file" — skip
    } else {
      // Context line (space-prefixed or empty)
      lineMap.set(newLineNum, line.length > 0 ? line.slice(1) : "");
      newLineNum++;
    }
  }

  // Flush last file
  flushFile();

  console.log(`[CLIFF Diff] Total files extracted: ${Object.keys(fileMap).join(", ") || "(none)"}`);
  return fileMap;
}



function getSeverityBadge(severity: SeverityLevel): string {
  switch (severity) {
    case "critical":
      return "🚨 CRITICAL";
    case "high":
      return "🔴 HIGH";
    case "medium":
      return "🟡 MEDIUM";
    case "low":
    default:
      return "🔵 LOW";
  }
}

export function formatFindingMarkdown(finding: Finding, includeFileHeader: boolean = true): string {
  const badge = getSeverityBadge(finding.severity);
  const locStr = finding.location || (finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : null);
  const locationHeader = includeFileHeader
    ? locStr
      ? `📍 \`${locStr}\`\n\n`
      : "`[File location unconfirmed]`\n\n"
    : "";

  const evidenceBlock = finding.evidence.length
    ? finding.evidence.map((e) => `> \`${e}\``).join("\n")
    : "*No direct snippet evidence attached*";

  return (
    `${locationHeader}` +
    `**${badge} — ${finding.title}**\n\n` +
    `${finding.description}\n\n` +
    `**Evidence:**\n${evidenceBlock}\n\n` +
    `**Why it matters:**\n${finding.why_it_matters}\n\n` +
    `**Suggested Fix:**\n${finding.suggested_fix}\n\n` +
    `**Confidence:** \`${finding.confidence.toUpperCase()}\``
  );
}

export function formatMainReviewMarkdown(reviewData: ReviewResult): string {
  const riskBadge = getSeverityBadge(reviewData.risk_level);
  const breaking = reviewData.breaking_changes?.length
    ? reviewData.breaking_changes.map((b) => `- ${b}`).join("\n")
    : "- None detected";

  let findingsSection = "";
  if (reviewData.findings && reviewData.findings.length > 0) {
    findingsSection = reviewData.findings
      .map((f, i) => `### Finding #${i + 1}\n\n${formatFindingMarkdown(f, true)}`)
      .join("\n\n---\n\n");
  } else {
    findingsSection = "✓ No high-confidence issues found.";
  }

  return (
    `### 🛡️ CLIFF AI Evidence-Based Code Review\n\n` +
    `**Overall Risk Level:** ${riskBadge}\n\n` +
    `**Summary:**\n${reviewData.summary}\n\n` +
    `**Breaking Changes:**\n${breaking}\n\n` +
    `**Detailed Findings:**\n\n${findingsSection}`
  );
}

export async function publishGithubReview(
  repoFullName: string,
  prNumber: number,
  reviewData: ReviewResult,
  token: string,
  diffText?: string,
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  const mainBody = formatMainReviewMarkdown(reviewData);

  // Prepare inline comments for findings that have both file and line specified
  const candidates = (reviewData.findings || [])
    .filter((f): f is Finding & { file: string; line: number } => Boolean(f.file && f.line));

  // GitHub rejects (422) review comments whose line is not part of the PR diff.
  // Only keep lines that were actually added/modified in the diff to avoid 422.
  let validInline: (Finding & { file: string; line: number })[] = [];
  if (diffText) {
    const changedLinesMap: Record<string, Set<number>> = {};
    for (const f of candidates) {
      if (!changedLinesMap[f.file]) {
        changedLinesMap[f.file] = extractChangedLinesFromDiff(diffText, f.file);
      }
      if (changedLinesMap[f.file].size > 0 && changedLinesMap[f.file].has(f.line)) {
        validInline.push(f);
      } else {
        console.log(`[CLIFF] Skipping inline comment for ${f.file}:${f.line} — line is not an added/changed line in the diff.`);
      }
    }
  } else {
    validInline = candidates;
  }

  const inlineComments = validInline.map((f) => ({
    path: f.file,
    line: f.line,
    side: "RIGHT",
    body: formatFindingMarkdown(f, false),
  }));

  // Try posting via GitHub PR Review API (supports inline comments)
  if (inlineComments.length > 0) {
    try {
      const reviewUrl = `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/reviews`;
      await axios.post(
        reviewUrl,
        {
          body: mainBody,
          event: reviewData.risk_level === "critical" || reviewData.risk_level === "high" ? "REQUEST_CHANGES" : "COMMENT",
          comments: inlineComments,
        },
        { headers },
      );
      console.log(`[CLIFF] Successfully posted PR Review with ${inlineComments.length} inline comment(s) to #${prNumber}`);
      return;
    } catch (err: any) {
      console.warn(`[CLIFF] PR inline review post failed (${err?.message}). Falling back to main comment issue posting.`);
    }
  }

  // Fallback or default: post as main issue comment
  await postGithubComment(repoFullName, prNumber, reviewData, token);
}

export async function postGithubComment(
  repoFullName: string,
  prNumber: number,
  reviewData: ReviewResult,
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`;
  const commentBody = formatMainReviewMarkdown(reviewData);

  await axios.post(
    url,
    { body: commentBody },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  console.log(`[CLIFF] Successfully posted main comment to PR #${prNumber}`);
}

