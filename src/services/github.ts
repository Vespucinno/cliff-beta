import axios from "axios";
import { ReviewResult, Finding, SeverityLevel } from "../types";

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
  const locationHeader = includeFileHeader
    ? finding.file
      ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`\n\n`
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
): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  const mainBody = formatMainReviewMarkdown(reviewData);

  // Prepare inline comments for findings that have both file and line specified
  const inlineComments = (reviewData.findings || [])
    .filter((f): f is Finding & { file: string; line: number } => Boolean(f.file && f.line))
    .map((f) => ({
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

