test("expiry rejects normalized impossible dates and non-ISO input", () => {
  for (const value of ["04/15/2028", "2028-04-31T12:00:00Z", "1900-02-29T00:00:00Z",
    "0003-02-29T00:00:00Z", new Date(NaN), null, 0, false, undefined]) {
    assert.throws(() => isExpired(value, 0), TypeError, String(value));
  }
  for (const value of ["2000-02-29T00:00Z", "0000-02-29T00:00:00Z",
    "0042-06-15T12:30:00Z", "2028-04-30T18:00:00.500+05:30"]) {
    const instant = Date.parse(value);
    assert.equal(isExpired(value, instant - 1), false);
    assert.equal(isExpired(value, instant), true);
  }
});

test("expiry distinguishes omitted now from explicit invalid values without early clock reads", () => {
  assert.equal(isExpired.length, 1);
  assert.equal(isExpired("1970-01-01T00:00:01Z", 0), false);
  const original = Date.now;
  let reads = 0;
  Date.now = () => { reads += 1; return 1000; };
  try {
    for (const value of [undefined, null, false, "0", NaN, Infinity, new Date(NaN)]) {
      assert.throws(() => isExpired("1970-01-01T00:00:01Z", value), TypeError);
    }
    assert.throws(() => isExpired("invalid"), TypeError);
    assert.equal(reads, 0);
    assert.equal(isExpired("1970-01-01T00:00:01Z"), true);
    assert.equal(reads, 1);
  } finally { Date.now = original; }
});
