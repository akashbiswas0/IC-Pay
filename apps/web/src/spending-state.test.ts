import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeSpendingDraft,
  draftMatchesPolicy,
  formFromPolicy,
  newSpendingDraft,
  parsePointsLimit,
  spendingDraftKey,
} from "./spending-state";
test("browser drafts retain incomplete input without persisting consent", () => {
  const value = {
    perPayment: "0.",
    total: "",
    expiry: "2026-09-27T13:00",
    selected: ["merchant-a"],
    consent: true,
  };
  const restored = decodeSpendingDraft(JSON.stringify(value));
  assert.deepEqual(restored, {
    maxPointsPerPayment: "",
    merchantScope: "selected",
    useRewards: false,
    perPayment: "0.",
    total: "",
    expiry: value.expiry,
    selected: value.selected,
  });
  assert.equal(decodeSpendingDraft('{"selected":null}'), null);
  assert.equal(decodeSpendingDraft("broken"), null);
  assert.notEqual(
    spendingDraftKey("origin", "a"),
    spendingDraftKey("origin", "b"),
  );
  assert.notEqual(
    spendingDraftKey("origin", "a"),
    spendingDraftKey("other", "a"),
  );
});

test("points permission distinguishes automatic, zero and a saved partial limit", () => {
  assert.equal(parsePointsLimit(""), null);
  assert.equal(parsePointsLimit("0"), "0");
  assert.equal(parsePointsLimit("0020"), "20");
  assert.equal(
    parsePointsLimit(((1n << 256n) - 1n).toString()),
    ((1n << 256n) - 1n).toString(),
  );
  assert.throws(() => parsePointsLimit((1n << 256n).toString()));
  for (const invalid of ["1.5", "-1", "1e3", "Infinity"])
    assert.throws(() => parsePointsLimit(invalid));
  const policy = {
    enabled: true,
    perPaymentLimit: "100",
    totalLimit: "500",
    spent: "0",
    reserved: "0",
    expiresAt: "2033-05-18T03:33:20Z",
    merchantIds: [],
    merchantScope: "all" as const,
    useRewards: true,
    maxPointsPerPayment: "5",
  };
  const draft = formFromPolicy(policy, 0);
  assert.equal(draft.maxPointsPerPayment, "5");
  assert(draftMatchesPolicy(draft, policy, 0));
  assert(!draftMatchesPolicy({ ...draft, maxPointsPerPayment: "" }, policy, 0));
  assert(
    !draftMatchesPolicy({ ...draft, maxPointsPerPayment: "0" }, policy, 0),
  );
  assert.equal(
    decodeSpendingDraft(JSON.stringify(draft))?.maxPointsPerPayment,
    "5",
  );
});
test("reward consent is off for legacy drafts and must match the saved policy", () => {
  const policy = {
    enabled: true,
    perPaymentLimit: "100",
    totalLimit: "500",
    spent: "0",
    reserved: "0",
    expiresAt: "2033-05-18T03:33:20Z",
    merchantIds: ["shop"],
    useRewards: true,
  };
  const draft = formFromPolicy(policy, 0);
  assert.equal(draft.useRewards, true);
  assert.equal(
    draftMatchesPolicy({ ...draft, useRewards: false }, policy, 0),
    false,
  );
  assert.equal(
    decodeSpendingDraft(JSON.stringify({ ...draft, useRewards: "true" })),
    null,
  );
});
test("saved policy restores both limits and selected merchants", () => {
  const policy = {
    enabled: true,
    perPaymentLimit: "200000",
    totalLimit: "500000",
    spent: "30000",
    reserved: "0",
    expiresAt: "2033-05-18T03:33:20Z",
    merchantIds: ["one", "two"],
  };
  const result = formFromPolicy(policy, 3);
  assert.equal(result.perPayment, "200");
  assert.equal(result.total, "500");
  assert.deepEqual(result.selected, ["one", "two"]);
  assert(
    draftMatchesPolicy({ ...result, selected: ["two", "one"] }, policy, 3),
  );
  assert(!draftMatchesPolicy({ ...result, selected: ["one"] }, policy, 3));
});

test("new edits use all shops without changing the current selected policy", () => {
  const policy = {
    enabled: true,
    perPaymentLimit: "100",
    totalLimit: "500",
    spent: "0",
    reserved: "0",
    expiresAt: "2033-05-18T03:33:20Z",
    merchantIds: ["existing-shop"],
  };
  const existing = formFromPolicy(policy, 0);
  assert.equal(existing.merchantScope, "selected");
  const draft = newSpendingDraft(policy, 0);
  assert.equal(draft.merchantScope, "all");
  assert.deepEqual(draft.selected, []);
  assert.deepEqual(policy.merchantIds, ["existing-shop"]);
  assert.equal(draftMatchesPolicy(draft, policy, 0), false);
  assert.equal(newSpendingDraft(null, 0).merchantScope, "all");
  const allPolicy = {
    ...policy,
    merchantScope: "all" as const,
    merchantIds: [],
  };
  assert.equal(draftMatchesPolicy(draft, allPolicy, 0), true);
  assert.equal(
    draftMatchesPolicy({ ...draft, merchantScope: "selected" }, allPolicy, 0),
    false,
  );
});
test("stored approval terms preserve explicit scope and reject ambiguous all-shop lists", () => {
  const draft = newSpendingDraft(null, 18);
  assert.deepEqual(decodeSpendingDraft(JSON.stringify(draft)), draft);
  const old = { ...draft, merchantScope: undefined, selected: ["old-shop"] };
  const restored = decodeSpendingDraft(JSON.stringify(old));
  assert.equal(restored?.merchantScope, "selected");
  assert.deepEqual(restored?.selected, ["old-shop"]);
  assert.equal(
    decodeSpendingDraft(JSON.stringify({ ...draft, merchantScope: "future" })),
    null,
  );
  assert.equal(
    decodeSpendingDraft(JSON.stringify({ ...draft, selected: ["shop"] })),
    null,
  );
});
