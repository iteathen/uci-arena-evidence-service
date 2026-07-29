import { createHash } from "node:crypto";

export const PROFILE_SCHEMA = "uci_time_profile_v3";
export const PREVIOUS_PROFILE_SCHEMA = "uci_time_profile_v2";
export const LEGACY_PROFILE_SCHEMA = "uci_time_profile_v1";
export const TIME_POLICY_VERSION = "persistent_mcgs_relative_clock_temporal_v4";
export const REQUIRED_MCGS_TIME_POLICY = "RelativeClockTemporalV1";

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Object(value) {
  const digest = createHash("sha256")
    .update(Buffer.from(canonicalJson(value), "utf8"))
    .digest("hex");
  return `sha256:${digest}`;
}

export function validateStoredProfile(profile) {
  if (![PROFILE_SCHEMA, PREVIOUS_PROFILE_SCHEMA, LEGACY_PROFILE_SCHEMA]
    .includes(profile?.schema)) {
    throw new Error(`unexpected profile schema: ${profile?.schema}`);
  }
  if (profile.qualified !== true || profile.gates?.passed !== true) {
    throw new Error("timing profile is not qualified");
  }
  if (profile.predictive_controller?.enabled_by_profile !== false
      || profile.predictive_controller?.default_enabled !== false) {
    throw new Error("timing profile attempts to enable the predictive controller");
  }
  const providerReserveUs = profile.schema === PROFILE_SCHEMA
    ? profile.calibration?.provider_batch_reserve_us
    : profile.schema === PREVIOUS_PROFILE_SCHEMA
      ? profile.calibration?.provider_service_reserve_us
      : profile.calibration?.provider_runtime_status?.conservative_provider_service_reserve_us;
  if (!Number.isSafeInteger(providerReserveUs)
      || providerReserveUs < 1
      || providerReserveUs > 5_000_000) {
    throw new Error("timing profile provider-service reserve is missing or invalid");
  }
  const backupEmitReserveUs = profile.schema === PROFILE_SCHEMA
    ? profile.calibration?.backup_emit_reserve_us
    : 1000;
  if (!Number.isSafeInteger(backupEmitReserveUs)
      || backupEmitReserveUs < 0
      || backupEmitReserveUs > 5_000_000) {
    throw new Error("timing profile backup/emission reserve is missing or invalid");
  }
  if (profile.schema === PROFILE_SCHEMA) {
    if (profile.identity?.time_policy_version !== TIME_POLICY_VERSION) {
      throw new Error(
        `timing profile time policy is stale: ${profile.identity?.time_policy_version ?? "missing"}`,
      );
    }
    if (profile.identity?.search?.search_core === "mcgs"
        && profile.identity?.search?.mcgs?.time_policy
          !== REQUIRED_MCGS_TIME_POLICY) {
      throw new Error("timing profile does not bind RelativeClockTemporalV1");
    }
    const overhead = profile.applicability?.move_overhead_ms;
    if (overhead?.minimum !== 250
        || overhead?.maximum !== 1500
        || JSON.stringify(overhead?.tested_values)
          !== JSON.stringify([250, 650, 700, 1500])) {
      throw new Error("timing profile Move Overhead applicability is incomplete");
    }
  }
  const iterationForecastScalePermille = profile.schema === LEGACY_PROFILE_SCHEMA
    ? 1000
    : profile.calibration?.iteration_forecast_scale_permille;
  if (!Number.isSafeInteger(iterationForecastScalePermille)
      || iterationForecastScalePermille < 1000
      || iterationForecastScalePermille > 8000) {
    throw new Error("timing profile iteration forecast scale is missing or invalid");
  }
  const expectedDigest = sha256Object(profile.identity);
  if (profile.identity_sha256 !== expectedDigest) {
    throw new Error(
      `timing profile identity digest mismatch: expected ${expectedDigest} got ${profile.identity_sha256}`,
    );
  }
  return {
    ...profile,
    calibration: {
      ...profile.calibration,
      provider_service_reserve_us: providerReserveUs,
      provider_batch_reserve_us: providerReserveUs,
      backup_emit_reserve_us: backupEmitReserveUs,
      iteration_forecast_scale_permille: iterationForecastScalePermille,
    },
  };
}
