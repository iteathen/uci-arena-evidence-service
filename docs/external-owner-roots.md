# External compute-owner roots

Evidence Service may be configured with `externalOwnerRoots`, a bounded list of
existing directories whose processes and owner packets are treated as external
foreground compute authorities during resource admission.

The paths are detection-only. They do not select a target, runtime, engine,
provider, workspace, or installation layout. Relative paths are resolved from
the configuration file directory and duplicate paths are removed. Missing paths
are ignored so optional external owners may be absent, but every existing path
must be an exact regular directory. Regular files, devices, sockets, FIFOs, and
symbolic links fail configuration loading instead of acquiring foreground-owner
authority.

A configuration may supply at most 64 non-empty paths. The canonical field and
an older input-only compatibility field cannot appear together. Runtime status,
serialized configuration projections, and newly written configuration use only
`externalOwnerRoots`.
