import { STEPSECURITY_API_URL } from "./configs";
import * as core from "@actions/core";
import { getGHESInputs, isGHES } from "./common";

const TLS_STATUS_ATTEMPTS = 3;
const TLS_STATUS_TIMEOUT_MS = 3000;
const TLS_STATUS_RETRY_BASE_DELAY_MS = 1000;
const TLS_STATUS_MAX_RETRY_AFTER_MS = 5000;

// 429 and 5xx are transient; any other non-200 status is a final answer.
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds) || seconds < 0) {
    return 0;
  }
  return Math.min(seconds * 1000, TLS_STATUS_MAX_RETRY_AFTER_MS);
}

function backoffMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** (attempt - 1) + Math.random() * (baseDelayMs / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isTLSEnabled(
  owner: string,
  retryBaseDelayMs: number = TLS_STATUS_RETRY_BASE_DELAY_MS
): Promise<boolean> {
  let tlsStatusOwner = owner;
  if (isGHES()) {
    const inputs = getGHESInputs();
    if (!inputs) {
      return false;
    }

    tlsStatusOwner = `${inputs.customer}::${inputs.server_name}::${owner}`;
  }

  const tlsStatusEndpoint = `${STEPSECURITY_API_URL}/github/${tlsStatusOwner}/actions/tls-inspection-status`;

  core.info(`[!] Checking TLS_STATUS: ${owner}`);
  // On exhaustion the last attempt decides, matching the single-attempt behaviour.
  for (let attempt = 1; ; attempt++) {
    const isLastAttempt = attempt >= TLS_STATUS_ATTEMPTS;
    let delayMs = backoffMs(attempt, retryBaseDelayMs);
    try {
      const resp = await fetch(tlsStatusEndpoint, {
        signal: AbortSignal.timeout(TLS_STATUS_TIMEOUT_MS),
      });
      if (resp.status === 200) {
        core.info(`[!] TLS_ENABLED: ${owner}`);
        return true;
      }
      if (!isRetryableStatus(resp.status) || isLastAttempt) {
        if (isRetryableStatus(resp.status)) {
          core.info(`[!] TLS_STATUS returned ${resp.status} after ${attempt} attempts`);
        }
        core.info(`[!] TLS_NOT_ENABLED: ${owner}`);
        return false;
      }
      core.info(`[!] TLS_STATUS returned ${resp.status} (attempt ${attempt}/${TLS_STATUS_ATTEMPTS}), retrying`);
      delayMs = Math.max(delayMs, retryAfterMs(resp.headers.get("retry-after")));
    } catch (e) {
      if (isLastAttempt) {
        core.info(`[!] Unable to check TLS_STATUS. Defaulting to TLS enabled.`);
        return true;
      }
      core.info(`[!] Unable to check TLS_STATUS (attempt ${attempt}/${TLS_STATUS_ATTEMPTS}): ${e}, retrying`);
    }
    await sleep(delayMs);
  }
}

export function isGithubHosted() {
  const runnerEnvironment = process.env.RUNNER_ENVIRONMENT || "";
  return runnerEnvironment === "github-hosted";
}
