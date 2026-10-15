-- Anthropic Messages API provider: price for provider-run server tool requests.
-- The Messages API reports web searches separately from tokens (usage.server_tool_use) and
-- bills them per request. A price version may now carry that per-request price; without it,
-- a call that reported searches stays unpriced and keeps its full reservation.
ALTER TABLE provider_model_prices
  ADD COLUMN micro_usd_per_server_tool_request bigint CHECK(micro_usd_per_server_tool_request BETWEEN 0 AND 100000000),
  ADD CONSTRAINT provider_model_prices_server_tool_withdrawn CHECK(status = 'active' OR micro_usd_per_server_tool_request IS NULL);
