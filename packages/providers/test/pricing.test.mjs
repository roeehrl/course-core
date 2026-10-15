import test from 'node:test';
import assert from 'node:assert/strict';
import { modelPricingSchema, priceUsage, pricingCovers } from '../dist/index.js';

// Synthetic operator-entered prices; not a vendor rate card.
const pricing = (extra = {}) => ({ versionId: 'price-v1', currency: 'USD', inputMicroUsdPerMillionTokens: 300_000,
  outputMicroUsdPerMillionTokens: 2_500_000, cachedInputMicroUsdPerMillionTokens: 75_000, microUsdPerRequest: null,
  microUsdPerOutputSecond: null, ...extra });
const tokens = (extra = {}) => ({ input: 1000, output: 200, total: 1300, cachedInput: 400, thoughts: 100, toolInput: 0, ...extra });
const receipt = (attempts, extra = {}) => ({ accounting: { accountingKey: 'k' }, providerId: 'p', modelId: 'm', operation: 'tutor',
  attempts, inputCharacters: 10, requestedMaxOutputTokens: 512, requestedVideoSeconds: null, observedImageCount: null,
  observedVideoCount: null, cost: null, ...extra });
const ok = (t = tokens(), attempt = 1) => ({ attempt, status: 200, outcome: 'response', tokens: t });

test('token cost separates cached input, bills thinking as output and rounds up once per receipt', () => {
  // (1000-400)*0.3 + 400*0.075 + (200+100)*2.5 = 180 + 30 + 750 = 960 micro-USD exactly.
  const result = priceUsage(receipt([ok()]), pricing());
  assert.equal(result.reason, null);
  assert.deepEqual(result.cost, { currency: 'USD', microUsd: 960, pricingVersionId: 'price-v1', basis: 'reported_usage',
    billable: { inputTokens: 600, cachedInputTokens: 400, outputTokens: 300, requests: 1, outputSeconds: 0 } });
  // One token at 0.3 micro-USD rounds up to 1, never down to a free call.
  assert.equal(priceUsage(receipt([ok(tokens({ input: 1, output: 0, total: 1, cachedInput: 0, thoughts: 0 }))]), pricing()).cost.microUsd, 1);
  // Two attempts' fractions are summed before the single rounding: 2 * 0.3 = 0.6 -> 1, not 2.
  const one = tokens({ input: 1, output: 0, total: 1, cachedInput: 0, thoughts: 0 });
  assert.equal(priceUsage(receipt([ok(one, 1), ok(one, 2)]), pricing()).cost.microUsd, 1);
});

test('cached tokens use the input price when no cached price is set, and money stays integral', () => {
  const result = priceUsage(receipt([ok()]), pricing({ cachedInputMicroUsdPerMillionTokens: null }));
  // 1000*0.3 + 300*2.5 = 300 + 750
  assert.equal(result.cost.microUsd, 1050);
  const large = priceUsage(receipt([ok(tokens({ input: 2_000_000, cachedInput: 0, output: 1_000_000, thoughts: 0, total: 3_000_000 }))]), pricing());
  assert.equal(large.cost.microUsd, 600_000 + 2_500_000);
  assert.ok(Number.isSafeInteger(large.cost.microUsd));
});

test('tool-use input is input, an unexplained total is charged as output, and rejected attempts are free', () => {
  const t = tokens({ cachedInput: 0, thoughts: 0, toolInput: 1000, total: 2400 });
  // input 1000+1000 at 0.3 = 600; output 200 + residual 200 at 2.5 = 1000.
  assert.equal(priceUsage(receipt([ok(t)]), pricing()).cost.microUsd, 1600);
  const rejected = { attempt: 1, status: 429, outcome: 'rejected', tokens: tokens({ input: null, output: null, total: null }) };
  assert.equal(priceUsage(receipt([rejected, ok(tokens(), 2)]), pricing()).cost.microUsd, 960);
});

test('unknown attempts, missing counters or impossible cache counts leave the receipt unpriced', () => {
  const unknown = { attempt: 1, status: 500, outcome: 'unknown', tokens: tokens({ input: null, output: null, total: null }) };
  assert.deepEqual(priceUsage(receipt([unknown, ok(tokens(), 2)]), pricing()), { cost: null, reason: 'usage_unknown' });
  assert.equal(priceUsage(receipt([ok(tokens({ input: null }))]), pricing()).reason, 'usage_unknown');
  assert.equal(priceUsage(receipt([ok(tokens({ output: null, total: null }))]), pricing()).reason, 'usage_unknown');
  assert.equal(priceUsage(receipt([ok(tokens({ cachedInput: 2000 }))]), pricing()).reason, 'usage_unknown');
  // Output missing but total reported: the residual is billed as output, never dropped.
  assert.equal(priceUsage(receipt([ok(tokens({ output: null, thoughts: null, cachedInput: 0, total: 1300 }))]), pricing()).cost.microUsd, 300 + 750);
});

test('per-request and per-second prices; a version without a matching price is incomplete', () => {
  const requestOnly = pricing({ inputMicroUsdPerMillionTokens: null, outputMicroUsdPerMillionTokens: null, cachedInputMicroUsdPerMillionTokens: null, microUsdPerRequest: 2000 });
  assert.equal(priceUsage(receipt([ok(tokens({ input: null }))]), requestOnly).cost.microUsd, 2000);
  assert.equal(priceUsage(receipt([ok()]), pricing({ microUsdPerRequest: 40 })).cost.microUsd, 1000);
  const video = receipt([ok(tokens({ input: null, output: null, total: null }))], { operation: 'video_submit', requestedVideoSeconds: 6 });
  const perSecond = pricing({ microUsdPerOutputSecond: 350_000 });
  assert.deepEqual(priceUsage(video, perSecond).cost.billable, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 1, outputSeconds: 6 });
  assert.equal(priceUsage(video, perSecond).cost.microUsd, 2_100_000);
  assert.equal(priceUsage({ ...video, operation: 'video_poll' }, perSecond).cost.microUsd, 0);
  assert.deepEqual(priceUsage(video, pricing()), { cost: null, reason: 'pricing_incomplete' });
  assert.equal(pricingCovers(pricing(), 'video'), false);
  assert.equal(pricingCovers(perSecond, 'video'), true);
  assert.equal(pricingCovers(requestOnly, 'tokens'), true);
});

test('pricing versions validate their own shape', () => {
  for (const bad of [pricing({ outputMicroUsdPerMillionTokens: null }), pricing({ inputMicroUsdPerMillionTokens: null, outputMicroUsdPerMillionTokens: null }),
    pricing({ inputMicroUsdPerMillionTokens: 0.5 }), pricing({ currency: 'EUR' }), pricing({ inputMicroUsdPerMillionTokens: -1 }),
    pricing({ microUsdPerRequest: 100_000_001 }), { ...pricing(), extra: 1 }])
    assert.equal(modelPricingSchema.safeParse(bad).success, false, JSON.stringify(bad));
  assert.throws(() => priceUsage(receipt([ok()]), pricing({ outputMicroUsdPerMillionTokens: 1.5 })));
});
