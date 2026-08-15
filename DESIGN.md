# Visual System

## Direction

Wishadel Demolition Terminal uses a restrained Arknights-inspired information system rather than a conventional fantasy/game frame.

- Base: near-black, ash gray, and off-white.
- Signals: restricted red and hot pink; amber/cyan only for exceptional status semantics.
- Rules: 1 px structure, 2 px active edges, 3-4 px alerts.
- Type: condensed grotesk for display labels, neutral sans for UI, tabular monospace for codes.
- Geometry: square or chamfered panels, asymmetric editorial alignment, no decorative rounded cards.
- Texture: subtle scan lines, grid, halftone, tape, and paint only at low opacity.
- Motion: state signals only; reduced-motion users receive a static fallback.

Explosive circles, diagonal paint, debris, stickers, and distressed typography belong to hero, selected, or critical states. Repeated working surfaces stay quiet and readable.

## Component Grammar

- Sidebar: tactical navigation rail, portrait kept at original aspect ratio, active row marked by a red edge and numeric code.
- Composer: thin angular shell, one active edge, compact status code, no thick raster border.
- User bubble: clipped corners, red transmission edge, dense but readable body.
- Tool/reasoning rows: low-contrast black layer with a narrow state rail.
- Dialog/menu: dark terminal surface, three-pixel red header rule, explicit control contrast.
- Status: coded micro-labels and short step animation, not generic neon glow.

## Avoid

- Full-screen red saturation or constant grunge.
- Thick realistic metal frames, rivets, or faux 3D game HUD chrome.
- Distressed body text and illegible microcopy.
- Excessive diagonals that compete with content.
- Pill-heavy controls, glassmorphism, large rounded cards, or generic cyberpunk neon.
- Copying official logos, typography lockups, or artwork without redistribution permission.

## Research Sources

Official or publisher-operated references used to understand the visual vocabulary:

- [Arknights Global](https://www.arknights.global/)
### W / Wis'adel and event references

- [Wiš'adel Special PV](https://www.youtube.com/watch?v=c8vwSEPKwcM)
- [W Animation PV](https://www.youtube.com/watch?v=h-YBCKvSgTU)
- [Contract Signing Session 1](https://www.youtube.com/watch?v=qJIUW5i3dmE)
- [Contract Signing Session 2](https://www.youtube.com/watch?v=65z9kk8bu_Q)
- [Arsonist](https://www.youtube.com/watch?v=p_kCisNUzHY)
- [Renegade](https://www.youtube.com/watch?v=rJuSmn9tovI)
- [Absolved Will Be the Seekers exhibition](https://www.arknights.global/V-contest/Absolvedwillbetheseekers/exhibition/)

Observed recurring vocabulary across these first-party references: charcoal/steel and white bases, signal red or red-orange, close character juxtaposition, destructive circular compositions, oversized headlines, angular silhouettes, fractured collage, haze, fabric, debris, thin technical rules, warning bars, triangles, and crosshair-like marks. These are visual observations, not claims about official UI specifications.

### Wider Arknights UI and contrast references

- [Darknights Memoir Animation PV](https://www.youtube.com/watch?v=nHtUnZEBQR8)
- [Darknights Memoir trailer](https://www.youtube.com/watch?v=s_6iLn-my9I)
- [Babel Official Trailer](https://www.youtube.com/watch?v=ptTcDSQF8nw)
- [Babel Animation PV](https://www.youtube.com/watch?v=bEYhYlijdac)
- [Episode 14: Absolved Will Be the Seekers](https://www.youtube.com/watch?v=QLuShrJyurE)
- [Arknights Official - Yostar](https://www.youtube.com/@ArknightsOfficialYostar)
- [Arknights Global](https://www.arknights.global/)
- [Monster Siren Records](https://monster-siren.hypergryph.com/)
- [Arknights on the App Store](https://apps.apple.com/us/app/arknights/id1464872022)
- [Arknights on Google Play](https://play.google.com/store/apps/details?id=com.YoStarEN.Arknights)
- [Yostar](https://www.yostar.com/)
- [Hypergryph](https://www.hypergryph.com/)

The broader UI references reinforce charcoal/steel terrain, white HUD marks, cyan friendly/deployable states, red hostile or hazard states, amber counters, compact icon rows, tabular numerals, angular panels, hard crops, route lines, tile outlines, progress fractions, and telemetry. The theme therefore keeps working surfaces neutral and uses red as a state signal rather than bathing every surface in red.

### Comparative implementation reference

Implementation coverage was compared with [Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale). This project borrows coverage ideas and lifecycle discipline, not its assets or ornamental design. The comparison informed coverage of the sidebar, workspace tree, title/header, hero, composer, conversation bubbles, reasoning/tool rows, question and Todo cards, Cordis panels, dialogs/menus, responsive states, reduced motion, and cleanup on unload.

Interpretive caution: demolition/sabotage symbolism, split-memory meaning, and red as a character signature are design readings derived from the references, not quoted official facts. No official logos, event lockups, or unlicensed reference images are bundled.
