import axios from "axios";
import { getPrDiff, publishGithubReview, postGithubComment, extractFileContentsFromDiff } from "./github";
import { runHermesAnalysis } from "./hermes";
import { ReviewResult } from "../types";

export function formatHelpGuideMarkdown(): string {
  return (
    `### 🤖 CLIFF AI Bot Command Guide\n\n` +
    `You can control the CLIFF AI Reviewer directly by typing these commands in PR comments:\n\n` +
    `| Command | Description | Example |\n` +
    `| :--- | :--- | :--- |\n` +
    `| \`cl help\` | Displays this interactive command reference guide. | \`cl help\` |\n` +
    `| \`cl review\` | Re-runs the evidence-based AI code review on all changes in this PR. | \`cl review\` |\n` +
    `| \`cl full-review\` | Triggers a comprehensive repository-wide security and quality audit across all code files. | \`cl full-review\` |\n\n` +
    `*Note: Commands are case-insensitive and can be typed anywhere in a comment line.*`
  );
}

export async function handleGithubCommand(payload: any, token?: string): Promise<boolean> {
  const commentText = (payload?.comment?.body || payload?.review_comment?.body || "").trim();
  if (!commentText || !/^\s*cl\b/i.test(commentText)) {
    return false;
  }

  const repoFullName = payload?.repository?.full_name;
  const issueNumber = payload?.issue?.number || payload?.pull_request?.number;

  if (!repoFullName || !issueNumber) {
    console.warn("[CLIFF Commands] Invalid payload structure for comment command.");
    return false;
  }

  const lowerCmd = commentText.toLowerCase();

  // COMMAND 1: cl help
  if (/^cl\s+help\s*$/i.test(commentText)) {
    console.log(`[CLIFF Commands] Executing 'cl help' for ${repoFullName} #${issueNumber}...`);
    const helpResult: ReviewResult = {
      summary: formatHelpGuideMarkdown(),
      risk_level: "low",
      breaking_changes: [],
      findings: [],
    };
    if (token) {
      await postGithubComment(repoFullName, issueNumber, helpResult, token);
    }
    return true;
  }

  // COMMAND 2: cl full-review — MUST be checked before cl review (substring collision)
  if (/^cl\s+full-review\s*$/i.test(commentText)) {
    console.log(`[CLIFF Commands] Executing 'cl full-review' for ${repoFullName} #${issueNumber}...`);
    let diffUrl = payload?.issue?.pull_request?.diff_url || payload?.pull_request?.diff_url;

    if (!diffUrl && token) {
      try {
        const prRes = await axios.get(`https://api.github.com/repos/${repoFullName}/pulls/${issueNumber}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        });
        diffUrl = prRes.data?.diff_url;
      } catch (err) {
        console.warn("[CLIFF Commands] Failed to fetch PR details from API:", err);
      }
    }

    const prTitle = `[FULL REPO AUDIT] ${payload?.issue?.title || payload?.pull_request?.title || `PR #${issueNumber}`}`;
    const diffText = diffUrl ? await getPrDiff(diffUrl, token) : "Full repository security & quality audit request.";
    const fileContentMap = diffUrl ? extractFileContentsFromDiff(diffText) : {};
    const reviewData = await runHermesAnalysis(diffText, prTitle, [], fileContentMap);

    if (token) {
      await publishGithubReview(repoFullName, issueNumber, reviewData, token, diffUrl ? diffText : undefined);
    }
    return true;
  }

  // COMMAND 3: cl review (Re-review current PR diff)
  if (/^cl\s+review\s*$/i.test(commentText)) {
    console.log(`[CLIFF Commands] Executing 'cl review' for ${repoFullName} #${issueNumber}...`);
    let diffUrl = payload?.issue?.pull_request?.diff_url || payload?.pull_request?.diff_url;

    if (!diffUrl && token) {
      try {
        const prRes = await axios.get(`https://api.github.com/repos/${repoFullName}/pulls/${issueNumber}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        });
        diffUrl = prRes.data?.diff_url;
      } catch (err) {
        console.warn("[CLIFF Commands] Failed to fetch PR details from API:", err);
      }
    }

    if (diffUrl) {
      const prTitle = payload?.issue?.title || payload?.pull_request?.title || `PR #${issueNumber}`;
      const diffText = await getPrDiff(diffUrl, token);
      const fileContentMap = extractFileContentsFromDiff(diffText);
      const reviewData = await runHermesAnalysis(diffText, prTitle, [], fileContentMap);

      if (token) {
        await publishGithubReview(repoFullName, issueNumber, reviewData, token, diffText);
      }
    } else {
      console.warn("[CLIFF Commands] Unable to determine diffUrl for PR re-review.");
    }
    return true;
  }

  console.warn(`[CLIFF Commands] Unknown command: "${commentText}"`);
  return false;
}
