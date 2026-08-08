import {
  timingProfileGatesPassed,
  timingProfilePermissions,
} from "@uci-arena/time-profile-contract";

export {
  timingProfileGatesPassed,
  timingProfilePermissions,
};

export function timingProfileCanPublish(profile) {
  const permissions = timingProfilePermissions(profile);
  return timingProfileGatesPassed(profile)
    && permissions.provider_safety_qualified
    && permissions.forecast_shadow_qualified
    && !permissions.adaptive_play_qualified
    && profile.predictive_controller?.default_enabled === false
    && profile.predictive_controller?.enabled_by_profile === false;
}
