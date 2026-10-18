import assert from "node:assert/strict";
import { test } from "node:test";
import { locationPatterns, placesLabel, primaryPlace, splitPlaces } from "../src/location.js";

const matches = (prefs: Parameters<typeof locationPatterns>[0], loc: string) =>
  (locationPatterns(prefs) ?? []).some((re) => re.test(loc));

test("several comma-joined cities each match (TASK-065)", () => {
  const prefs = { preferredCity: "Bengaluru, Pune" };
  assert.equal(matches(prefs, "Bengaluru, Karnataka, India"), true);
  assert.equal(matches(prefs, "Pune, Maharashtra"), true);
  assert.equal(matches(prefs, "Mumbai"), false);
  assert.equal(matches(prefs, "Remote - India"), true);
});

test("no city or country means no filtering; 'Remote' alone is not a place", () => {
  assert.equal(locationPatterns({}), null);
  assert.equal(locationPatterns({ preferredCity: " , " }), null);
  assert.equal(locationPatterns({ preferredCity: "Remote" }), null);
});

test("user text is escaped, never a raw RegExp", () => {
  assert.doesNotThrow(() => locationPatterns({ preferredCity: "New York (NY" }));
  assert.equal(matches({ preferredCity: "New York (NY" }, "New York (NY), USA"), true);
  assert.equal(matches({ preferredCity: ".*" }, "Berlin"), false);
});

test("single-location searches use the first city; labels list them all", () => {
  assert.deepEqual(splitPlaces("Bengaluru, remote, Pune, bengaluru"), ["Bengaluru", "Pune"]);
  assert.equal(primaryPlace({ preferredCity: "Remote, Pune, Delhi", preferredCountry: "India" }), "Pune");
  assert.equal(primaryPlace({ preferredCountry: "India" }), "India");
  assert.equal(placesLabel({ preferredCity: "Bengaluru, Pune" }), "Bengaluru, Pune");
});
