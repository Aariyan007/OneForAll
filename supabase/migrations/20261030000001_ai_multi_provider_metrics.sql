-- Multi-provider AI runs: which provider answered, whether it reported token usage, the routing trail and the
-- token-optimization measurements, per run. Extends public.ai_runs (migration 20261028000003); additive and backward compatible.
--
--   provider                  gemini | groq | openrouter, the provider of the call that produced the answer (NULL: no call succeeded).
--   usage_reported            true when the provider reported token usage for every successful call of the run. When false the
--                             token columns are zeros that mean "unavailable", not "none used".
--   cost_known                true when estimated_cost_usd is complete (every call had a reported or tabulated price). When false
--                             the cost is a lower bound or absent: unknown prices are never treated as free.
--   baseline_tokens_estimate  estimated tokens of sending the whole stored snapshot in one request (NULL: not measured). Always an
--                             estimate (characters / 4); tokens saved are derived from it and are labelled estimated.
--   route                     {category, reason, attempts: [{provider, model, tier, outcome, ms, usageReported}]}: the routing
--                             trail, bounded to 4 KB. Never prompts, answers, provider messages or keys.
--   techniques                the optimizations the run actually applied, e.g. ["retrieval-based context selection"].
--
-- Existing rows: before this migration only Gemini existed, so provider is backfilled as 'gemini' for runs that called a model,
-- usage_reported is true where a non-zero input count was recorded (zeros mean the count was not kept), cost_known where a cost
-- was recorded. baseline_tokens_estimate stays NULL: no history is invented.
-- Rollback: drop the six columns and restore finish_ai_run from migration 20261028000003.
-- RLS is unchanged: the existing select policy covers the new columns and the table stays read-only for clients.

alter table public.ai_runs
  add column provider text check (provider is null or provider in ('gemini', 'groq', 'openrouter')),
  add column usage_reported boolean not null default false,
  add column cost_known boolean not null default false,
  add column baseline_tokens_estimate integer check (baseline_tokens_estimate is null or baseline_tokens_estimate >= 0),
  add column route jsonb check (route is null or octet_length(route::text) <= 4096),
  add column techniques jsonb check (techniques is null or (jsonb_typeof(techniques) = 'array' and octet_length(techniques::text) <= 1024));

update public.ai_runs set provider = 'gemini' where model is not null;
update public.ai_runs set usage_reported = true where input_tokens > 0;
update public.ai_runs set cost_known = true where estimated_cost_usd > 0;

create or replace function public.finish_ai_run(
  p_run_id uuid, p_status text, p_output jsonb, p_error_category text, p_error_message text, p_metrics jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  m jsonb := coalesce(p_metrics, '{}'::jsonb);
begin
  v_status := private.lock_own_ai_run(p_run_id);
  if p_status not in ('completed', 'failed', 'cancelled', 'timed_out') then
    raise exception 'finish_ai_run records terminal states only' using errcode = '22023';
  end if;
  if p_error_category is not null and p_error_category !~ '^[a-z_]{2,40}$' then
    raise exception 'Invalid error category' using errcode = '22023';
  end if;
  if jsonb_typeof(m) <> 'object' then raise exception 'Invalid metrics' using errcode = '22023'; end if;
  if (p_status = 'completed') <> (p_output is not null) then
    raise exception 'A completed run needs an output, and only a completed run has one' using errcode = '22023';
  end if;
  -- A run may end as failed or cancelled from any active state (failures before a model call included).
  if not (private.ai_transition_ok(v_status, p_status)
          or (p_status in ('failed', 'cancelled') and v_status not in ('completed', 'failed', 'cancelled', 'timed_out'))) then
    raise exception 'Invalid AI run transition % -> %', v_status, p_status using errcode = '55000';
  end if;

  update public.ai_runs a set
    status = p_status,
    output = p_output,
    error_category = p_error_category,
    error_message = left(p_error_message, 500),
    tier = coalesce(m ->> 'tier', a.tier),
    model = left(coalesce(m ->> 'model', a.model), 100),
    input_tokens = greatest(0, coalesce((m ->> 'input_tokens')::int, 0)),
    output_tokens = greatest(0, coalesce((m ->> 'output_tokens')::int, 0)),
    cached_input_tokens = greatest(0, coalesce((m ->> 'cached_input_tokens')::int, 0)),
    thinking_tokens = greatest(0, coalesce((m ->> 'thinking_tokens')::int, 0)),
    estimated_cost_usd = greatest(0, coalesce((m ->> 'estimated_cost_usd')::numeric, 0)),
    model_calls = greatest(0, coalesce((m ->> 'model_calls')::int, 0)),
    tool_calls = greatest(0, coalesce((m ->> 'tool_calls')::int, 0)),
    attempts = greatest(0, coalesce((m ->> 'attempts')::int, 0)),
    fallback_used = coalesce((m ->> 'fallback_used')::boolean, false),
    citations_dropped = greatest(0, coalesce((m ->> 'citations_dropped')::int, 0)),
    context_tokens_estimate = greatest(0, coalesce((m ->> 'context_tokens_estimate')::int, 0)),
    provider = coalesce(m ->> 'provider', a.provider),
    usage_reported = coalesce((m ->> 'usage_reported')::boolean, false),
    cost_known = coalesce((m ->> 'cost_known')::boolean, false),
    baseline_tokens_estimate = case when m ? 'baseline_tokens_estimate' then greatest(0, (m ->> 'baseline_tokens_estimate')::int) else null end,
    route = case when jsonb_typeof(m -> 'route') = 'object' then m -> 'route' else null end,
    techniques = case when jsonb_typeof(m -> 'techniques') = 'array' then m -> 'techniques' else null end,
    updated_at = now(),
    completed_at = now()
  where a.id = p_run_id;
  insert into public.ai_run_events (run_id, state, detail)
  values (p_run_id, p_status, case when p_error_category is null then null else jsonb_build_object('category', p_error_category) end);
end;
$$;
