# Green2Go — Vision & Product Spec

**One-line mission:** Green2Go is the 100% electrically-capable version of OnePlan — every feature OnePlan offers for general event planning, reinterpreted and built for event power distribution: generators, AC units, distro panels, and cable runs, true-to-scale on a satellite map or an uploaded site plan, producing a priced, professional-looking quote.

OnePlan is the reference point for *capability and feel* (browser-based, true-to-scale, drag-and-drop, georeferenced overlays, auto-generated Bill of Quantities). This isn't about matching OnePlan feature-for-feature as a literal copy — it's about matching its full capability while being the electrical specialist it isn't. We are not cloning OnePlan's code either; it's closed-source, so everything here gets built fresh. **Target: every feature on the list below, built for electrical.**

## Who this is for

A small rental company crew (currently: 2 people) planning event power layouts and generating quotes — in the office on a computer, and potentially on a jobsite phone/tablet later. Not a large production company with a trained CAD operator; it has to stay usable by someone without AutoCAD/Vectorworks experience.

## What's already built

- Satellite map mode (Mapbox) and custom uploaded PDF/image site-plan mode, both true-to-scale.
- Equipment placement (Gens, AC, Distro) sized correctly for real-world zoom, with a manual size-adjust control.
- Cable tool: draw runs by type (50A, 30A, Banded/2-0, 4/0, Quad, Cable Ramp), auto-splits into real stocked lengths (50ft/100ft) for pricing.
- Cable Ramp: drawn as an unfilled rectangle, ramp count derived from drawn length.
- Priced Bill of Materials from a real catalog (day/week/month rates), PDF export of site plan + quote.
- Netlify auto-deploy from GitHub `main`, password-gated.

## Full target feature list (OnePlan parity, adapted to electrical)

Grouped by area. ✅ built · 🔲 not built yet. This is the complete list — nothing here gets quietly dropped; phasing/order is a separate conversation from scope.

### Map & overlays
- ✅ Satellite map, true-to-scale
- ✅ Map view switcher — toggle between Satellite, Hybrid (satellite + street labels), and Streets, matching OnePlan's map-type switcher
- ✅ **Layers** — Equipment, Cable, and Cable Ramp can each be shown/hidden independently; hidden layers are excluded from the on-screen map, the BOM, and both exports (PDF and CSV), so a subset can be viewed or exported alone or combined
- 🔲 **Georeferenced overlay tool** — upload a site plan/CAD/aerial image, keep satellite imagery visible underneath, opacity slider to blend them, draggable corner handles + rotate handle to manually align the overlay to the real world (today it auto-places, forces full opacity, and hides satellite entirely — needs rework)
- 🔲 **Export layout as a re-importable overlay** — flatten the finished placement (equipment + cables, no base map) into a georeferenced image, usable as an overlay later (on this map or elsewhere), via the same import/alignment tool above
- 🔲 Multiple plans / multiple levels per project — for multi-site jobs or multi-story venues
- ✅ Exact coordinates shown for any placed object (equipment and cable/ramp runs, in the hover tooltip)
- 🔲 what3words location sharing — needs a what3words API key/account we don't have yet

### Placement & drawing
- ✅ Equipment placement, true-to-scale, with manual size override
- ✅ Cable runs with real stocked-length pricing (50ft/100ft)
- ✅ Cable Ramp as a drawn, counted rectangle
- ✅ **Real electrical connections** — cables snap to and validate against the real equipment topology (Generator → Distro/AC via camlock, Generator/50-Panel/Spiderbox → Spiderbox via 50A, Quad Panel → Quad Stringer/30A Extension), move with their equipment when dragged, and are removed when either end is deleted. Port counts aren't capped (T-adapters make that unrealistic to enforce) - only connection *type* compatibility is validated.
- 🔲 Resizable infrastructure/zones with length/area shown live as you draw (we already show cable length; general zone/barrier drawing with live area calc is new)
- 🔲 Dot planning — staff/personnel placement markers
- 🔲 Route plotting — pedestrian/vehicle path routes

### Object data
- 🔲 **Properties panel per placed object** — name, zone/area, setup time, electrical needs/notes, not just a fixed catalog type. This is the natural home for connection data too (see Real electrical connections above).

### Pricing & output
- ✅ Priced Bill of Materials from real catalog data (day/week/month)
- ✅ PDF export (site plan + priced quote)
- ✅ CSV export of placed objects
- 🔲 Permit-ready / clean export format (may just be a styling pass on the existing PDF export)
- 🔲 Share-by-link for stakeholders/crew (not just PDF) — ties to the overlay export above: a link could serve the georeferenced overlay for live viewing

### Visual design
- ✅ Top toolbar decluttered into File / Layers / Map dropdown menus (was a growing row of always-visible buttons)
- 🔲 **Real equipment iconography** — replace colored squares/triangles with letters in them with recognizable generator/AC/distro/cable symbols
- 🔲 **Consistent design system** — unified color palette, typography, panel styling across the whole app and PDF output, instead of the current ad-hoc look

### Access
- ✅ Password gate (lightweight, client-side deterrent)

## Working agreement

- This doc is the thing to consult at the start of a new phase instead of re-briefing from scratch.
- Scope is the full list above — nothing gets cut without you saying so. Order/phasing is decided separately, phase by phase.
- Confirm before starting large/expensive phases (visual redesign, data model changes for connections, overlay rework) since those are harder to partially undo.
- Update this doc as priorities shift or new requirements surface, so it stays the real source of truth rather than going stale.
- Real pricing/catalog data stays in `public/data/catalog.csv`, sourced only from numbers the business owner provides directly — never fabricated or guessed.
