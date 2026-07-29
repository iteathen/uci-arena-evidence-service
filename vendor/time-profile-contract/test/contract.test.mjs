import assert from "node:assert/strict";
import test from "node:test";

import {
  PROFILE_SCHEMA,
  canonicalJson,
  validateStoredProfile,
} from "../src/index.mjs";

test("canonical JSON is order-independent", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }),
    canonicalJson({ a: { b: 3, y: 2 }, z: 1 }));
});

test("profile validation fails closed before identity use", () => {
  assert.throws(
    () => validateStoredProfile({ schema: PROFILE_SCHEMA, qualified: false }),
    /not qualified/,
  );
});
