import { STEPSECURITY_API_URL } from "./configs";
import { isGHES } from "./common";
import { isTLSEnabled } from "./tls-inspect";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.GITHUB_SERVER_URL;
  delete process.env.INPUT_CUSTOMER;
  delete process.env["INPUT_SERVER-NAME"];
});

function mockFetch(impl: typeof fetch) {
  globalThis.fetch = impl as typeof fetch;
}

test("tls-inspect enabled", async () => {
  const owner = "h0x0er";
  const expectedUrl = `${STEPSECURITY_API_URL}/github/${owner}/actions/tls-inspection-status`;

  mockFetch(async (url, _init) => {
    expect(String(url)).toBe(expectedUrl);
    return new Response("", { status: 200 });
  });

  const got = await isTLSEnabled(owner);
  expect(got).toBe(true);
});

test("tls-inspect not enabled", async () => {
  const owner = "step-security";

  mockFetch(async () => new Response("unauthorized", { status: 401 }));

  const got = await isTLSEnabled(owner);
  expect(got).toBe(false);
});

test("tls-inspect qualifies owner in GHES", async () => {
  const owner = "ghes-org";
  const customer = "acme";
  const serverName = "ghes-prod";
  const serverUrl = "https://github.example.com";
  const expectedUrl = `${STEPSECURITY_API_URL}/github/${customer}::${serverName}::${owner}/actions/tls-inspection-status`;
  process.env.GITHUB_SERVER_URL = serverUrl;
  process.env.INPUT_CUSTOMER = customer;
  process.env["INPUT_SERVER-NAME"] = serverName;

  mockFetch(async (url, init) => {
    expect(String(url)).toBe(expectedUrl);
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    return new Response("", { status: 200 });
  });

  const got = await isTLSEnabled(owner);
  expect(got).toBe(true);
});

test("tls-inspect returns false when GHES inputs are missing", async () => {
  process.env.GITHUB_SERVER_URL = "https://github.example.com";
  process.env.INPUT_CUSTOMER = "acme";

  mockFetch(async () => {
    throw new Error("fetch should not be called");
  });

  const got = await isTLSEnabled("ghes-org");
  expect(got).toBe(false);
});

test("isGHES returns false for GitHub.com", () => {
  expect(isGHES()).toBe(false);
  expect(isGHES("https://github.com")).toBe(false);
});

test("isGHES returns true for GitHub Enterprise Server", () => {
  process.env.GITHUB_SERVER_URL = "https://github.example.com";

  expect(isGHES()).toBe(true);
  expect(isGHES("https://github.enterprise.local")).toBe(true);
});

test("isTLSEnabled returns true after 3 timed-out attempts when server is slow (regression test for AggregateError)", async () => {
  const owner = "slow-org";
  let calls = 0;

  mockFetch((_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }
    });
  });

  const start = Date.now();
  const result = await isTLSEnabled(owner, 0);
  const elapsed = Date.now() - start;

  expect(result).toBe(true);
  expect(calls).toBe(3);
  expect(elapsed).toBeLessThan(9500);
}, 15_000);

test("isTLSEnabled returns true on connection error without hanging", async () => {
  const owner = "broken-org";
  let calls = 0;

  mockFetch(async () => {
    calls++;
    const err = new TypeError("fetch failed");
    (err as Error & { cause?: unknown }).cause = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    throw err;
  });

  const start = Date.now();
  const result = await isTLSEnabled(owner, 0);
  const elapsed = Date.now() - start;

  expect(result).toBe(true);
  expect(calls).toBe(3);
  expect(elapsed).toBeLessThan(3500);
});

// Each entry is one attempt: an HTTP status, a Response, or an Error to throw.
function mockFetchSequence(...attempts: Array<number | Response | Error>) {
  const fetchMock = jest.fn(async () => {
    const next = attempts[Math.min(fetchMock.mock.calls.length - 1, attempts.length - 1)];
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return new Response("", { status: next });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("isTLSEnabled retries", () => {
  test("retries a 429 and returns true when a later attempt gets 200", async () => {
    const fetchMock = mockFetchSequence(429, 200);

    expect(await isTLSEnabled("test-org", 0)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries a 5xx and returns true when a later attempt gets 200", async () => {
    const fetchMock = mockFetchSequence(503, 500, 200);

    expect(await isTLSEnabled("test-org", 0)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("retries a network error and returns true when a later attempt gets 200", async () => {
    const fetchMock = mockFetchSequence(new TypeError("fetch failed"), 200);

    expect(await isTLSEnabled("test-org", 0)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("stops after 3 attempts of 429 and returns false", async () => {
    const fetchMock = mockFetchSequence(429, 429, 429, 200);

    expect(await isTLSEnabled("test-org", 0)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("treats 403 as final without retrying", async () => {
    const fetchMock = mockFetchSequence(403, 200);

    expect(await isTLSEnabled("test-org", 0)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("waits for Retry-After before retrying a 429", async () => {
    const fetchMock = mockFetchSequence(
      new Response("", { status: 429, headers: { "retry-after": "1" } }),
      200
    );

    const start = Date.now();
    expect(await isTLSEnabled("test-org", 0)).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
