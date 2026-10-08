# Evidence runtime v2 implementation plan

1. Test runtime v2 admission: exact inventory hashes/lengths, path/symlink
   rejection, unknown major, unsupported capability, preserved v1 admission.
   Add target-specific `src/runtime_v2_binding.mjs`; leave the v1 validator exact.
2. Test typed adapter request and normalized diagnostic result identity,
   rejecting drift, malformed games and mismatched producer. Extend adapters
   with a v2 branch; keep legacy argument/harvest behavior intact.
3. Persist exact generic registered-launch / component capability descriptors
   through additive catalog3 migration. Keep provider identity opaque, expose
   typed optional-unsupported state, and admit only provider-advertised campaigns
   with inventoried bounded schemas. Run source owner tests with retained SDK.
4. In the separate Vector branch, test a standalone engine-owned runtime
   component: chess.js referee, bounded UCI process lifecycle, clocks, terminal
   games, paired colors and timing measurements. Use public managed profiles.
5. Freeze source/idle/packaging-fixture evidence separately from signed Windows
   publication. Measure the real installed public engine once available; preserve exact
   physical identity and incomplete/error states. Freeze reviewable source
   heads independently from suite release and qualification claims.
