# NestLive — module boundaries

NestLive is a **separate MillionsNest product/module**, not a screen embedded
inside MusicScale and not a monolith that owns the other applications.

## What is separate

- GitHub repository: `prdanielcunha/nestlive`;
- web/PWA surface;
- local NestLive Node runtime installed on the presentation/audio PC;
- audio providers (X32, Soundcraft);
- production-control adapters (Holyrics, Resolume Arena, ProPresenter);
- Remote Mix relay protocol/service;
- release and hardware-certification lifecycle.

This lets NestLive evolve, install and fail independently from MusicScale,
NestFinance, NestJourney and the Hub.

## What is shared with the ecosystem

NestLive integrates through stable contracts:

- **MillionsNest Hub/Auth** — identity, organization and app entitlement;
- **MusicScale** — service/scale context, participants and roles;
- **NestAI** — future intelligence/assistive analysis, never the deterministic
  audio-control path;
- shared organization/venue/LiveSystem identifiers;
- navigation/launch handoff from the ecosystem.

A failure in cloud integrations must not stop the local worship-service path.

## Runtime shape

```text
MillionsNest Hub / MusicScale
        │ cloud context/auth
        ▼
Public NestLive Web/PWA ─────── Remote Mix Relay (optional)
        │ paired LAN                      ▲
        ▼                                 │ outbound only
NestLive Node on worship PC ──────────────┘
   ├── Audio provider → X32 / Soundcraft
   ├── Production provider → Holyrics
   ├── Visual provider → Resolume / ProPresenter
   └── observed-state / meters / diagnostics
```

The console LAN is never exposed to the internet. Local Mix remains usable
when internet/cloud is unavailable.

## Deployments

The module has three deployment classes that must not be confused:

1. **Web production** — public PWA/Remote Mix browser can be deployed whenever
   CI is green because unsupported hardware controls are fail-closed.
2. **Node beta/release** — installer can be built and distributed; signing and
   notarization depend on signing credentials.
3. **Hardware-certified production** — X32/Soundcraft control is only marked
   production-certified after physical evidence gates pass.

Therefore the web/module can be synchronized to production without pretending
that an untested console capability is certified.
