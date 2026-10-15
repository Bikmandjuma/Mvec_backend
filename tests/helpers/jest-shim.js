// Lets the Jest-style integration files run under `node --test`: describe/it,
// beforeAll/afterAll, expect() matchers, jest.spyOn and fake timers.
const nodeTest = require("node:test");
const assert = require("node:assert/strict");

const isEqual = (a, b) => {
  try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
};
const fmt = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

function matchers(actual, negate = false) {
  const check = (pass, message) => {
    if (negate ? pass : !pass) throw new assert.AssertionError({ message: `${negate ? "not " : ""}${message}`, actual });
  };
  const m = {
    toBe: (e) => check(Object.is(actual, e), `expected ${fmt(actual)} to be ${fmt(e)}`),
    toEqual: (e) => check(isEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(e ?? null))), `expected ${fmt(actual)} to equal ${fmt(e)}`),
    toStrictEqual: (e) => check(isEqual(actual, e), `expected ${fmt(actual)} to strictly equal ${fmt(e)}`),
    toBeTruthy: () => check(Boolean(actual), `expected ${fmt(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, `expected ${fmt(actual)} to be falsy`),
    toBeDefined: () => check(actual !== undefined, "expected value to be defined"),
    toBeUndefined: () => check(actual === undefined, `expected ${fmt(actual)} to be undefined`),
    toBeNull: () => check(actual === null, `expected ${fmt(actual)} to be null`),
    toHaveLength: (n) => check(actual != null && actual.length === n, `expected length ${actual?.length} to be ${n}`),
    toContain: (x) => check(actual != null && (typeof actual === "string" ? actual.includes(x) : [...actual].some((y) => Object.is(y, x) || isEqual(y, x))), `expected ${fmt(actual)} to contain ${fmt(x)}`),
    toBeGreaterThan: (n) => check(actual > n, `expected ${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n) => check(actual >= n, `expected ${actual} >= ${n}`),
    toBeLessThan: (n) => check(actual < n, `expected ${actual} < ${n}`),
    toBeLessThanOrEqual: (n) => check(actual <= n, `expected ${actual} <= ${n}`),
    toMatch: (re) => check(typeof re === "string" ? String(actual).includes(re) : re.test(String(actual)), `expected ${fmt(actual)} to match ${re}`),
    toHaveProperty: (...args) => {
      const [p, v] = args;
      const val = String(p).split(".").reduce((o, k) => (o == null ? undefined : o[k]), actual);
      check(val !== undefined && (args.length < 2 || isEqual(val, v)), `expected property ${p}`);
    },
    toHaveBeenCalled: () => check(actual.mock.calls.length > 0, "expected the spy to be called"),
    toHaveBeenCalledTimes: (n) => check(actual.mock.calls.length === n, `expected ${n} calls, got ${actual.mock.calls.length}`),
  };
  return m;
}

function expect(actual) {
  const m = matchers(actual);
  m.not = matchers(actual, true);
  m.resolves = new Proxy({}, { get: (_, k) => async (...a) => matchers(await actual)[k](...a) });
  m.rejects = new Proxy({}, { get: (_, k) => async (...a) => { let err; try { await actual; } catch (e) { err = e; } return matchers(err)[k](...a); } });
  return m;
}

function spyOn(obj, method) {
  const original = obj[method];
  let impl = (...args) => original.apply(obj, args);
  const spy = function (...args) { spy.mock.calls.push(args); return impl.apply(this, args); };
  spy.mock = { calls: [] };
  spy.mockImplementation = (fn) => { impl = fn; return spy; };
  spy.mockReturnValue = (v) => { impl = () => v; return spy; };
  spy.mockResolvedValue = (v) => { impl = async () => v; return spy; };
  spy.mockRejectedValue = (e) => { impl = async () => { throw e; }; return spy; };
  spy.mockRestore = () => { obj[method] = original; };
  obj[method] = spy;
  return spy;
}

let timersOn = false;
const jest = {
  setTimeout: () => {},
  spyOn,
  useFakeTimers: () => {
    if (timersOn) return;
    nodeTest.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
    timersOn = true;
  },
  useRealTimers: () => { if (timersOn) nodeTest.mock.timers.reset(); timersOn = false; },
  advanceTimersByTime: (ms) => nodeTest.mock.timers.tick(ms),
  fn: (impl = () => undefined) => { const holder = { f: impl }; return spyOn(holder, "f"); },
};

Object.assign(global, {
  describe: nodeTest.describe,
  it: nodeTest.it,
  test: nodeTest.test,
  beforeAll: nodeTest.before,
  afterAll: nodeTest.after,
  beforeEach: nodeTest.beforeEach,
  afterEach: nodeTest.afterEach,
  expect,
  jest,
});
