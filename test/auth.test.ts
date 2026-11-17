// Sign-in helpers that need no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addressKey } from "../src/auth.ts";

test("the per-network sign-in limit counts IPv4 addresses one by one and IPv6 by /64", () => {
  assert.equal(addressKey("203.0.113.7"), "203.0.113.7");
  assert.equal(addressKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(addressKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(addressKey("2001:0DB8:0001:0002::9"), "2001:db8:1:2::/64");
  assert.equal(addressKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(addressKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(addressKey("::1"), "0:0:0:0::/64");
});
