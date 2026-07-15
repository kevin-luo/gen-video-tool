# Motion worker

This directory defines the local Godot worker boundary for `Mesh Puppet` actors.
The desktop app sends a validated request JSON, a complete continuous character
texture, and `rig.json`. The worker responds with a result JSON and, once a rig
has been manually verified, may produce a transparent PNG sequence, WebM, or
alpha MOV.

Phase 1 intentionally implements protocol validation, executable detection, a
sample Godot project, and the Electron-callable process boundary. It does **not**
claim reliable automatic rigging or production mesh weights. Until those are
verified on real characters, the editor keeps `Mesh Puppet` disabled and guides
users to `Rigid Actor` or compliant `Pose Cut`.

Example invocation:

```text
godot --headless --path motion-worker/godot -- --request request.json --result result.json
```

No shell string is constructed by the app; the executable and every argument
are passed separately.
