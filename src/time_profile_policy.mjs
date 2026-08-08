const BASE_TIMING_GATES = Object.freeze([
  "legal_moves",
  "nonterminal_null_moves",
  "controller_disabled",
  "provider_timing_captured",
  "provider_service_reserve_valid",
  "applied_provider_service_reserve_covered",
  "applied_backup_emit_reserve_covered",
  "p99_deadline_overshoot_passed",
  "maximum_deadline_overshoot_passed",
  "passed",
]);

const MCGS_TIMING_GATES = Object.freeze([
  "mcgs_root_coverage_passed",
  "mcgs_policy_only_fallback_passed",
  "mcgs_graph_population_passed",
  "mcgs_async_overlap_passed",
  "mcgs_single_owner_passed",
  "mcgs_low_budget_fallback_passed",
  "mcgs_deterministic_fallback_passed",
  "mcgs_completion_integrity_passed",
  "mcgs_temporal_policy_passed",
  "mcgs_deadline_tail_telemetry_passed",
]);

function explicitBoolean(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.hasOwn(value, name)) return null;
  return value[name] === true;
}

export function timingProfileGatesPassed(profile) {
  if (profile?.schema !== "uci_time_profile_v3" || profile.qualified !== true) return false;
  const required = profile.identity?.search?.search_core === "mcgs"
    ? [...BASE_TIMING_GATES, ...MCGS_TIMING_GATES]
    : BASE_TIMING_GATES;
  return required.every((gate) => profile.gates?.[gate] === true);
}

export function timingProfilePermissions(profile) {
  const gatesPassed = timingProfileGatesPassed(profile);
  const explicitProvider = explicitBoolean(profile?.permissions, "provider_safety_qualified");
  const explicitForecast = explicitBoolean(profile?.permissions, "forecast_shadow_qualified");
  const explicitAdaptive = explicitBoolean(profile?.permissions, "adaptive_play_qualified");
  return {
    provider_safety_qualified: explicitProvider ?? gatesPassed,
    forecast_shadow_qualified: explicitForecast ?? gatesPassed,
    adaptive_play_qualified: explicitAdaptive ?? false,
  };
}

export function timingProfileCanPublish(profile) {
  const permissions = timingProfilePermissions(profile);
  return timingProfileGatesPassed(profile)
    && permissions.provider_safety_qualified
    && permissions.forecast_shadow_qualified
    && !permissions.adaptive_play_qualified
    && profile.predictive_controller?.default_enabled === false
    && profile.predictive_controller?.enabled_by_profile === false;
}
