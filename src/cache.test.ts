import { isCacheAccessRestricted } from "./cache";

describe("isCacheAccessRestricted", () => {
  const original = process.env.ACTIONS_CACHE_MODE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ACTIONS_CACHE_MODE;
    } else {
      process.env.ACTIONS_CACHE_MODE = original;
    }
  });

  it.each(["none", "read", "NONE", " Read "])(
    "returns true for cache-mode %p",
    (mode) => {
      process.env.ACTIONS_CACHE_MODE = mode;
      expect(isCacheAccessRestricted()).toBe(true);
    }
  );

  it.each(["read-write", "write", ""])(
    "returns false for cache-mode %p",
    (mode) => {
      process.env.ACTIONS_CACHE_MODE = mode;
      expect(isCacheAccessRestricted()).toBe(false);
    }
  );

  it("returns false when ACTIONS_CACHE_MODE is unset", () => {
    delete process.env.ACTIONS_CACHE_MODE;
    expect(isCacheAccessRestricted()).toBe(false);
  });
});
