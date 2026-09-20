import express, { Request, Response } from "express";
import dotenv from "dotenv";
import { getPrDiff, publishGithubReview, extractFileContentsFromDiff } from "./services/github";
import { runHermesAnalysis } from "./services/hermes";
import { handleGithubCommand } from "./services/commands";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

app.use(express.json());

async function processPrWorkflow(payload: any) {
  try {
    const prTitle = payload.pull_request.title;
    const prNumber = payload.pull_request.number;
    const repoName = payload.repository.full_name;
    const diffUrl = payload.pull_request.diff_url;

    console.log(`[CLIFF] Processing PR #${prNumber} for ${repoName}...`);

    const diffText = await getPrDiff(diffUrl, GITHUB_TOKEN);

    // Parse the diff to give tree-sitter real file content for line resolution
    const fileContentMap = extractFileContentsFromDiff(diffText);
    const fileCount = Object.keys(fileContentMap).length;
    console.log(`[CLIFF] Extracted content for ${fileCount} changed file(s): ${Object.keys(fileContentMap).join(", ")}`);

    const reviewData = await runHermesAnalysis(diffText, prTitle, [], fileContentMap);

    if (GITHUB_TOKEN) {
      await publishGithubReview(repoName, prNumber, reviewData, GITHUB_TOKEN, diffText);
      console.log(`[CLIFF] Successfully published review for PR #${prNumber}`);
    } else {
      console.warn("[CLIFF] GITHUB_TOKEN missing. Skipping review publish.");
    }
  } catch (error) {
    console.error("[CLIFF] Workflow error:", error);
  }
}

// Runs slow AI work AFTER the HTTP response to GitHub is already sent.
// This avoids webhook timeout/retry: GitHub gets its 200 ACK immediately,
// then the OpenRouter call + PR comment happen asynchronously in the background.
function runInBackground(task: () => Promise<unknown>): void {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((error) => console.error("[CLIFF] Background task error:", error));
  });
}

app.post("/webhook/github", (req: Request, res: Response) => {
  const payload = req.body;
  const githubEvent = req.headers["x-github-event"] as string;
  const action = payload?.action;

  console.log(`[CLIFF] Received event: ${githubEvent} / action: ${action}`);

  // Acknowledge GitHub immediately (first second) to prevent webhook timeout.
  res.status(200).json({ status: "processing" });

  // issue_comment = PR conversation tab comment; pull_request_review_comment = inline diff comment
  const commentText = payload?.comment?.body?.trim() || "";

  if (commentText && /^cl\b/i.test(commentText)) {
    console.log(`[CLIFF] Command detected: "${commentText}"`);
    runInBackground(() => handleGithubCommand(payload, GITHUB_TOKEN));
  } else if (["opened", "synchronize"].includes(action) && githubEvent === "pull_request") {
    runInBackground(() => processPrWorkflow(payload));
  }
});

app.listen(PORT, () => {
  console.log(`[CLIFF] TypeScript Backend active on http://localhost:${PORT}`);
});
