import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { validateStoredProfile } from "../../../engine/tools/qualify_uci_time_profile.mjs";
import { resolveActiveTarget } from "./identity.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function targetProjection(profile) {
  return {
    model_id: String(profile.identity?.model?.model_id ?? ""),
    model_fingerprint: String(profile.identity?.model?.model_fingerprint ?? ""),
    engine_sha256: String(profile.identity?.engine?.executable_sha256 ?? ""),
    engine_build_fingerprint: String(
      profile.identity?.engine?.engine_build_fingerprint ?? "",
    ),
    provider: String(profile.identity?.search?.provider_effective ?? ""),
    provider_numeric_fingerprint: String(
      profile.identity?.provider?.provider_numeric_fingerprint ?? "",
    ),
    hardware_driver_fingerprint: String(
      profile.identity?.provider?.hardware_driver_fingerprint ?? "",
    ),
    onnx_runtime_version: String(
      profile.identity?.provider?.onnx_runtime_version ?? "",
    ),
    search_core: String(profile.identity?.search?.search_core ?? ""),
    threads: Number(profile.identity?.search?.threads ?? 0),
    root_workers: Number(profile.identity?.search?.root_workers ?? 0),
    split_depth: Number(profile.identity?.search?.split_depth ?? 0),
    batch_size: Number(profile.identity?.search?.batch_size_effective ?? 0),
    batch_wait_us: Number(
      profile.identity?.search?.batch_wait_us_effective ?? 0,
    ),
  };
}

function loadProjection(filename, source) {
  const resolved = path.resolve(filename);
  if (!existsSync(resolved)) {
    throw new Error(`configured timing profile is missing: ${resolved}`);
  }
  const entry = lstatSync(resolved);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`configured timing profile is not a regular file: ${resolved}`);
  }
  const bytes = readFileSync(resolved);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`configured timing profile is invalid JSON: ${resolved}: ${error.message}`);
  }
  const profile = validateStoredProfile(parsed);
  return {
    schema: "uci_arena_evidence_profile_v1",
    source,
    path: resolved,
    sha256: sha256(bytes),
    profileSchema: profile.schema,
    qualified: true,
    publishedAt: String(profile.published_at ?? ""),
    identitySha256: profile.identity_sha256,
    targetIdentity: targetProjection(profile),
    permissions: {
      provider_safety_qualified:
        profile.permissions.provider_safety_qualified,
      forecast_shadow_qualified:
        profile.permissions.forecast_shadow_qualified,
      adaptive_play_qualified:
        profile.permissions.adaptive_play_qualified,
    },
    servicePublication:
      profile.service_publication &&
      typeof profile.service_publication === "object" &&
      !Array.isArray(profile.service_publication)
        ? {
            schema: String(profile.service_publication.schema ?? ""),
            job_id: String(profile.service_publication.job_id ?? ""),
            dataset_id: String(profile.service_publication.dataset_id ?? ""),
            resource_interval_id: String(
              profile.service_publication.resource_interval_id ?? "",
            ),
            published_at: String(
              profile.service_publication.published_at ?? "",
            ),
          }
        : null,
  };
}

export function listQualifiedProfiles(config, catalog) {
  const candidates = [];
  const active = resolveActiveTarget(config);
  if (active.target) {
    const filename = path.join(
      config.runtimeModelsRoot,
      active.target.modelId,
      "cache",
      "uci_time_profile_v3.json",
    );
    if (existsSync(filename)) {
      candidates.push({
        filename,
        source: "service_live_cache",
        target: active.target,
      });
    }
  }
  for (const target of catalog.targets()) {
    const filename = path.join(
      config.runtimeModelsRoot,
      target.modelId,
      "cache",
      "uci_time_profile_v3.json",
    );
    if (existsSync(filename)) {
      candidates.push({
        filename,
        source: "service_live_cache",
        target,
      });
    }
  }
  for (const filename of config.profileImports) {
    candidates.push({ filename, source: "explicit_import", target: null });
  }

  const seen = new Set();
  const profiles = [];
  for (const candidate of candidates) {
    const key = path.resolve(candidate.filename).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const projection = loadProjection(candidate.filename, candidate.source);
    if (candidate.target &&
        (projection.targetIdentity.model_id !== candidate.target.modelId ||
         projection.targetIdentity.model_fingerprint !==
           String(candidate.target.modelFingerprint))) {
      throw new Error(
        `published timing profile target identity mismatch: ${projection.path}`,
      );
    }
    profiles.push(projection);
  }
  return profiles.sort((left, right) => left.path.localeCompare(right.path));
}
