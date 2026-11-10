# Optimierungs-Fundstellen (Rechenkern)

Stand 10. November 2026, Commit `2cb6118`. Ziel: schneller rechnen, ohne das
Ergebnis ungenauer zu machen. Drei Ebenen: mathematisch/logisch,
programmiertechnisch, WASM-Assembler. Jede Fundstelle trägt einen Status:

- **gemessen** – am unveränderten Produktionscode gemessen
- **Prototyp** – in einer Scratch-Kopie umgesetzt, gebaut, gemessen und Pixel verglichen
- **Hypothese** – begründet, aber nicht umgesetzt; Detailanalyse steht aus

Abschnitte 1–8 beschreiben die Analyse am Commit `2cb6118`; die Umsetzung steht
in Abschnitt 0. Patches und Messskripte
liegen unter `build/internal/optimization-analysis/` (nicht versioniert,
`make clean` löscht sie).

## 0. Umsetzungsstand (10. November 2026)

Entscheidungen: Bilder dürfen von der Basis abweichen, wenn das Orakel-Kriterium
gilt (gleicher Escape-Status und Iteration, höchstens 1 RGB-Stufe); M8 umsetzen,
weil es Zeilen spart; P4 nur bei spürbarem Gewinn; ein voller 4K-A/B am Ende.
Stichproben wie in Abschnitt 2 (jede 53. Kachel, ein Thread, `--no-liftoff`),
Pixel jeweils mit der Basis verglichen: **in allen Stichproben bytegleich**.

| Nr. | Ergebnis | Wirkung (Stichprobe, Basis → neu) |
| --- | --- | --- |
| M1 | umgesetzt, Beweis an `perturb_pixel`; zusätzlich Referenzsample-, Rebase- und Randterm, die in der Basis fehlten | DD-Rückfälle elefant 96 335 → 25 790 |
| P1 | umgesetzt als eigene, nicht eingebettete Funktion; Bereich auf 2⁻⁴⁸⁰ erweitert (auch globale Referenzen), Unterlauf über einen absoluten 2⁻¹⁰⁶⁰-Term statt Außenrundung bewiesen | boundary-80 2,9×, boundary-400 2,0×, preperiodic-400 5× |
| P1-SIMD | umgesetzt: 4 Pixel in 2 × `f64x2`, Ereignisse skalar, bitgleich pro Bahn; bei hoher Ereignisrate (c ≈ −2) skalar | elefant 3,97 s → 2,65 s |
| M3 | umgesetzt für den Double-Pfad: 2⁻⁵⁰ statt 2⁻⁴⁸ (Beweis an `perturb_rounding`); Extended bleibt 2⁻⁴⁸ | DD-Rückfälle elefant 25 790 → 13 137 |
| P2 | umgesetzt: DD-Rückfälle einer Kachel gesammelt, 4 Bahnen verschränkt, bitgleich | elefant 6,0 s → 4,0 s |
| M4 | DD-Schwelle −52 statt −80; **neu: DD-Störungsrechnung** mit eigenem Exponenten pro Pixel vor dem Festkomma-Pfad (Referenz als DD im Payload); nähere Referenz nicht nötig | preperiodic-1600 (30 Kacheln) 36,7 s → 1,2 s, stern 10×, branch29 4,6× |
| M5 | umgesetzt: Start bei `−e+160` Bit; `−e+128` erzeugte Wiederholungen | preperiodic-400 −39 %, stern −22 % |
| M6/P5 | umgesetzt: spaltenweise Akkumulation, Kurzprodukt ab Spalte `fraction−2` mit exaktem Vollprodukt-Rückfall, Rundungsflag über ctz | Festkomma-Regionen −8 bis −13 % |
| P3 | umgesetzt: 4 Vektoren, ein `any_true`, Zyklustest alle 64 statt 16 Schritte (16 war in desktop-zoom12-6 langsamer) | flache Regionen 5–18 % schneller, bitgleich |
| M8 | umgesetzt: `alignAxis` rastet am Ende einer Navigation um höchstens ¼ Pixel ein, wenn die Achse sichtbar ist; URL/API-Ansichten nie | bis 50 % weniger Zeilen |
| P4 | **nicht umgesetzt**: auch als Obergrenze (Division entfernt, Farbe falsch) höchstens ±3 % | – |
| M7 | gemessen, **offen**: schwarze Pixel tragen in overview/navigation-7/desktop-zoom9 55–67 % der Iterationen, in den übrigen flachen Regionen 0 %; absolut 0,02–0,2 s pro 4K-Bild | – |
| M2, M9 | wie analysiert nicht weiterverfolgt | – |
| A4 | Befund: Durch weitere Aufrufstellen inlinete Clang `ext()` nicht mehr; als Aufruf mit Rückgabe über den Speicher kostete das 10–20 % in jeder Extended-Operation. `ext` ist jetzt `always_inline` (handentrollte oder ausgelagerte Subnormal-Varianten waren 6 % bzw. 20 % langsamer) | – |
| A5 | Node druckt TurboFan-Code mit `--print-wasm-code`. ARM64: Der DD-Kern hat in der WASM-Schleife keine Speicherzugriffe, aber 28 lebende Vektoren; V8 lagert auf den Stack aus. Kandidat für später: 1 statt 2 Vektorpaare messen | – |

Voller 4K-A/B (8 Worker, 25 Regionen, 3 Paare abwechselnd, Median, Optionsmaske
3851 gegen 28427; `build/internal/ab-final/`): **gesamt 1648 s → 168 s (9,8×)**.
preperiodic-1600 743 → 3,3 s, preperiodic-400 16,9 → 0,84 s, stern-explosion
26,5 → 1,7 s, links-ring 195 → 19 s, cusp32 175 → 18 s, elefant 141 → 17 s,
seahorse-24 95 → 17 s, branch29 85 → 28 s, cusp38 110 → 52 s, boundary-400
3,2 → 1,1 s. 19 Regionen sind bytegleich. Die 6 übrigen (desktop-zoom20, stern,
drei-kern-samen, branch29, seahorse-24, seahorse-18) entstehen nur aus der
anderen Kachelaufteilung des adaptiven Schedulers (lokale Referenzen an anderer
Stelle, empfindliche Pixel): Mit der aufgezeichneten Kachelfolge der Basis
rechnet der Kandidat alle sechs bytegleich nach. An solchen Pixeln weichen
Basis und Kandidat gleichermaßen vom Orakel ab (vorbestehend, Koordinatenrundung).

Kurze flache Bilder, 10 Paare: overview, seahorse-10, navigation-7,
desktop-zoom12-6 5–22 % schneller. **interior-40 ist 8 % langsamer** (18,3 →
19,9 ms; nur analytisch belegte Innenpixel). Ursache eingegrenzt auf den
eingeschwungenen TurboFan-Code der Pixelschleife von `render_deep_tile`
(3–4 % im Einzelthread, Liftoff gleich); weder die DD-Kopie noch die
Optionsmaske noch ein ausgelagerter Extended-Pfad ändern das, ein separater
Innenpixel-Vorlauf war schlechter. Offen zur Entscheidung.

cusp38 zerlegt der Scheduler in ~31 000 Kacheln à 32×8 (Ziel 12 ms pro
Auftrag), jede mit eigener lokaler Referenz. Der Scheduler bleibt unverändert;
stattdessen wurden die Kosten pro Referenz gesenkt. Profil einer 32×8-Kachel:
57 % DD-Reihenpräfix, 16 % Festkomma-Bahn, 6 % BLA-Tabellen. Umgesetzt:
- Präfixprodukte und -summen in `f64x2` (Real-/Imaginärteil je eine Lane),
  bitgleich: −5 %.
- DD-Präfix erst ab 512 statt 128 Pixeln (`PRECISE_SERIES_MIN_PIXELS`): bei
  32×8 ist die Double-Reihe jetzt schneller (cusp38 −27 %, elefant −14 %,
  branch29 −6 %), ab 1024 Pixeln bleibt das Präfix gleich gut oder 2–3× besser.
- O-Schranke über Suffixsummen (15 statt 72 nach außen gerundete Operationen;
  gültige, nicht bitgleiche obere Schranke): −4 % bei 64×32.
Vollbild, gleiche Optionsmaske, 2 Paare: cusp38 44,5 → 26,3 s, elefant, links-ring,
branch29, cusp24 −3 bis −7 %. Abweichende Bilder (branch29, seahorse-24) sind bei
gleicher Kachelfolge bytegleich. Eine aus einer Nachbarreferenz abgeleitete
Referenz (DD-Störung statt Festkomma) zielt nur noch auf die ~20–25 % Bahnkosten
einer 32×8-Kachel.

Offen bzw. Kandidaten: M7 (Kugelzertifikat, Nutzen klein), ein genauerer
DD-Randtest (der Randtest nutzt 2⁻⁴⁶|δ|, branch29 behält 1 562 Festkomma-Pixel),
Registerdruck im DD-Kern, x86-Messung von P3. Vorbestehende Lücke, nicht
behoben: Der präzise Bailout-Rand der Referenz vernachlässigt `reference_error`
(≤ 2⁻⁶⁴|Z|); relevant nur, wenn |z|²−4 kleiner als etwa 2⁻⁶⁰ wird.

## 1. Kurzfassung

Der größte Hebel liegt nicht im flachen SIMD-Kern, sondern im Zoombereich
Pixelabstand 2⁻²⁶ bis 2⁻⁸⁰ (lokale Referenz pro Kachel). Dort kostet ein Pixel
230- bis 580-mal mehr als im flachen Pfad, bei nur 1,6-fachem Iterationsbudget
(seahorse-10: 0,055 µs/Pixel, seahorse-18: 12,5–31,9 µs/Pixel).

| Nr. | Fundstelle | Status | Wirkung |
| --- | --- | --- | --- |
| M1 | Fehlerschranke der Störungsrechnung nutzt `2(|Z|+|δ|)` statt `2|z|` | Prototyp | 60–75 % weniger Rückfälle; preperiodic-400 3,0× |
| P1 | Störungsrechnung in einfachen Doubles statt `Extended` (2⁻²⁶…2⁻⁸⁰) | Prototyp | 2,3× bis 4,8× auf fünf Regionen, pixelidentisch |
| P2 | Double-Double-Rückfall ist latenzgebunden und skalar | Hypothese | erwartet etwa 3× auf den DD-Anteil |
| M4 | DD-Rückfall ist unterhalb etwa 2⁻⁵⁰ aussichtslos und wird trotzdem versucht | gemessen | vermeidet verlorene Arbeit, Stufe fehlt in der Tiefe |
| M5 | Startpräzision `−2·e+192` Bit ist großzügig | Hypothese | Limb-Kosten ∝ n², Faktor 2–4 denkbar |
| M6 | Kurzprodukt mit exaktem Rückfall für Limb-Multiplikation | Hypothese | bis 2× auf Limb-Produkte, bitidentisch |
| P3 | Flacher Kern: 4 statt 2 verschränkte `f64x2`-Vektoren, Blocktest | gemessen (Nachbau des Kerns) | 0,52 → 0,31 ns pro Pixel-Iteration (1,7×) |
| M8 | Spiegelung greift nur bei exakt ausgerichtetem Raster | gemessen | bis 2×, braucht eine Entscheidung (Abschnitt 3.6) |

Reihenfolge der Empfehlung: M1, dann P1, dann P2/M4, dann M5/M6, dann P3.

## 2. Messgrundlage

Node 26.13 / V8, Apple M5 Pro (virtuell), ein Thread, nur Kernzeit
(`render_tile` / `deep_render_tile`). Stichprobe: jede 53. Produktionskachel
(10 von 510 Kacheln à 256×64) der 4K-Referenzregionen; Zähler aus den
`deep_stat_*`-Exporten. Keine Vollbild-Hashes, kein Browser, kein x86.

Kosten pro Iteration, aus den Stichproben abgeleitet:

| Pfad | ns pro Iteration | Quelle |
| --- | ---: | --- |
| Flacher SIMD-Kern | 0,50 | Kachel ohne frühe Abbrüche |
| Störungsrechnung in `Extended` | ≈ 35 | boundary-80: 134 ms / 3,8 Mio. |
| Double-Double direkt | ≈ 17 | Elefant, cusp32 |
| Störungsrechnung in Doubles (Prototyp) | ≈ 4,5 | Elefant |
| Festkomma, 11 Limbs | ≈ 200 | stern-explosion |
| Festkomma, 34 Limbs | ≈ 1000 | preperiodic-400 |

Profil der unveränderten Basis (10 Kacheln, ms und Zähler in Millionen):

| Region | e | ms | Störungs-It. | DD-Rückfälle | DD-It. | Festkomma-It. |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cusp24 | −34 | 1366 | 21,7 | 9 503 | 32,2 | 0 |
| elefant | −37 | 29 525 | 543 | 96 335 | 620 | 0 |
| links-ring | −42 | 27 158 | 503 | 74 654 | 557 | 0,02 |
| seahorse-24 | −34 | 17 555 | 348 | 77 478 | 273 | 3,6 |
| branch29 | −39 | 11 200 | 77,9 | 144 810 | 276 | 22,5 |
| cusp32 | −43 | 31 275 | 607 | 69 954 | 580 | 0,02 |
| cusp38 | −48 | 12 373 | 236 | 23 537 | 238 | 0,01 |
| stern-explosion | −64 | 1 937 | 6,7 | 54 709 | 9,5 | 7,9 |
| preperiodic-400 | −410 | 1 276 | 9,1 | – | – | 0,95 |
| boundary-80 | −90 | 134 | 3,8 | – | – | 0 |

Lesart: In den Cusp-Regionen fällt fast jedes nicht entkommende Pixel nach
vergeblicher Störungsrechnung auf Double-Double zurück und rechnet dort bis zum
Limit (Elefant: 96 335 Rückfälle bei 93 000 schwarzen Pixeln, 6 400 DD-Iterationen
je Rückfall). Die Störungsiterationen davor sind verlorene Arbeit.

Varianten auf denselben Kacheln (ms; Pixel jeweils identisch zur Basis,
159 744 bzw. 81 920 Pixel je Region):

| Region | Basis | M1 | M1 + P1 | Faktor |
| --- | ---: | ---: | ---: | ---: |
| cusp24 | 1366 | 1310 | 400 | 3,4× |
| drei-kern-samen | 725 | 497 | 173 | 4,2× |
| seahorse-18 | 2005 | 2055 | 648 | 3,1× |
| stern-explosion | 1937 | 1056 | 852 | 2,3× |
| elefant (5 Kacheln) | 10 103 | 8 821 | 2 088 | 4,8× |
| preperiodic-400 | 1276 | 420 | – | 3,0× |
| boundary-80 (30 Kacheln) | 463 | 432 | 367 | 1,3× |
| boundary-100 (30 Kacheln) | 437 | 411 | 409 | 1,1× |
| boundary-400 (30 Kacheln) | 1318 | 1230 | 1217 | 1,1× |

Die drei Boundary-Fälle sind dreimal im Wechsel A/B/C gemessen, Streuung unter
1 %. Sie sind genau die Fälle, an denen das frühere f64-Experiment laut
`docs/NOTES.md` gescheitert ist (+6 bis +26 %); hier zeigt keiner eine Regression.
Das ersetzt nicht den vollen 4K-A/B-Vergleich mit acht Workern.

## 3. Ebene 1: mathematisch / logisch

### M1 – Engere Verstärkung in der Fehlerschranke (Prototyp)

`core/deep-zoom.c:881` verstärkt den Fehler pro Schritt mit `2(|Z|+|δ|)+error`.
Für die Rekursion δ' = 2Zδ + δ² + dc gilt mit berechnetem δ̃ = δ + e exakt

    e' = e·(2z̃ − e) + ρ,   z̃ = Z + δ̃

also `|e'| ≤ |e|·(2|z̃| + |e|) + |ρ|`. Die Norm `|z̃|` liegt als `anorm` aus dem
vorigen Durchlauf bereits vor. Die Dreiecksungleichung `|Z|+|δ|` ist überall
dort lose, wo δ nicht klein gegen Z ist; im parabolischen Kanal am Cusp
(|2z| ≈ 1 über Tausende Schritte) wächst die alte Schranke um Größenordnungen
schneller als der wahre Fehler. Der Direktpfad (`fixed_pixel`, `dd_pixel`)
nutzt schon `2|z|`.

- Patch: 4 Zeilen, `build/internal/optimization-analysis/tight-bound.patch`.
  Spart zusätzlich ein `norm_ext` (mit Wurzel) und ein `add_ext` pro Iteration.
- Wirkung: DD-Rückfälle cusp24 9 503 → 3 137, drei-kern-samen 96 320 → 23 348,
  seahorse-18 108 214 → 44 664, elefant 40 750 → 9 969; Festkomma-Rückfälle
  preperiodic-400 2 850 → 471.
- Im mittleren Bereich allein kaum Zeitgewinn, weil eine `Extended`-Iteration
  (35 ns) teurer ist als eine DD-Iteration (17 ns). Erst mit P1 zahlt es sich aus.
- **Offen:** Beweis im Stil des Projekts. Kernargument für die Rundung der
  Referenz: ohne Rebase gilt |δ| ≤ |z|, also |Z| ≤ 2|z|, damit deckt die
  2⁻⁵⁰-Aufblähung von `norm_ext` den Referenzfehler 2⁻⁵³|Z|; nach Rebase ist Z₀ = 0.
  Der BLA-Zweig (Zeile 873) ist unverändert und separat zu prüfen.

### M2 – Relatives Fehlerkriterium (geprüft, kein Gewinn)

Der Test `error < 2⁻³⁰·|z|` in jeder Iteration (Zeile 886) wirkt bei Durchgängen
nahe null unnötig streng. Ein absoluter Test `error < 2⁻³⁰` erzeugte aber *mehr*
Rückfälle (drei-kern-samen 23 348 → 34 129), weil |z| meist über 1 liegt. Die
verbleibenden Rückfälle stammen also aus echtem Wachstum der Schranke, nicht aus
kleinen |z|. Nicht weiterverfolgen.

### M3 – Rundungseinheit 2⁻⁴⁸ (Hypothese)

Jeder Schritt addiert `2⁻⁴⁸·(|a|+|b|+|c|)`. Die tatsächliche Rundung einer
komplexen Multiplikation plus zweier Additionen liegt bei wenigen 2⁻⁵³. Nach
einem Rebase ist δ = z, die Störungsrechnung verliert ihren Präzisionsvorteil,
und dieser Term wird mit der vollen Ableitung verstärkt: Fehler am Ende
≈ N·2⁻⁴⁸·|dc|/d (d = Abstand des Pixels zum Rand). Eine bewiesene Konstante von
2⁻⁵⁰ würde die Rückfallzone um den Faktor 4 verkleinern. Mit einfachen Doubles
(P1) ist der Beweis einfacher als für `Extended`, dessen `add_ext` Summanden
unter 2⁻⁵⁶ verwirft.

### M4 – Rückfallstufen (gemessen, Umbau offen)

- `precise_pixel` (Zeile 839) versucht DD bis e ≥ −80. Bei stern-explosion
  (e = −64) scheitert mit M1 jeder DD-Rückfall erneut und geht in Festkomma
  (18 596 von 18 596; Basis 41 457 von 54 709). 106 Bit reichen dort nicht für
  die 2⁻³²-Toleranz. Die DD-Iterationen sind verloren. Schwelle auf etwa
  e ≥ −50 senken oder vorab aus e und Toleranz entscheiden.
- In der Tiefe (e < −80) gibt es zwischen Störungsrechnung (35 ns) und
  Festkomma (1 µs bei 34 Limbs) keine Stufe. preperiodic-400: 1,7 % der Pixel
  kosten 75 % der Zeit. Kandidat: Störungsrechnung mit Double-Double-δ gegen
  dieselbe Referenz. Braucht die Referenzbahn in DD (16 Byte mehr pro
  Iteration; bei 410 368 Iterationen 6,5 MiB, innerhalb des 16-MiB-Budgets).
- Der Fehler wächst mit |dc|. Für Rückfallpixel wäre eine nähere Referenz
  (Kachel vierteln) oft billiger als Direktrechnung. `DEEP_ADAPTIVE_REFERENCE`
  existiert, ist aber abgeschaltet und nur im globalen Modus aktiv.

### M5 – Präzisionsbudget (Hypothese)

`web/engine-worker.js:40` und `web/reference-worker.js:34` starten mit
`max(view.bits, −2·e + 192)` Bit. Bei e = −64 sind das 320 Bit plus ganzzahliger
Limb (11 Limbs), bei e = −410 1056 Bit. Nötig sind grob −e plus Toleranz plus
Reserve. Der Kern hat bereits eine zertifizierte Fehlerschranke mit
automatischer Wiederholung (`precision_needed`, `deep_grow_precision`, Fortsetzung
der Kachel). Ein Start bei etwa −e + 128 wäre deshalb sicher; im Zweifel wird
nachgelegt. Schulbuch-Produkte kosten ∝ n²: 7 statt 11 Limbs wären 2,5×.
**Offen:** Wiederholungsrate und Gesamtzeit als Funktion der Startpräzision
messen; Ergebnisse sind zertifiziert, aber nicht mehr bitgleich zur Basis.

### M6 – Kurzprodukt mit exaktem Rückfall (Hypothese)

`multiply_big`/`square_big` (Zeilen 342–354) berechnen das volle 2n-Limb-Produkt
und verwerfen die untere Hälfte bis auf das Flag `rounded_product`.

- Das Flag ist ohne die untere Hälfte exakt bestimmbar: die unteren
  32·fraction Bit von a·b sind genau dann null, wenn ctz(a) + ctz(b) ≥ 32·fraction.
- Der obere Teil braucht nur die Spalten ab `fraction − 2`. Der Übertrag aus
  dem Rest ist beschränkt; nur wenn die Schutz-Limbs dicht an einem Überlauf
  liegen (Wahrscheinlichkeit etwa n/2³²), wird das volle Produkt nachgerechnet.

Ergebnis bitidentisch, Schulbuch-Aufwand etwa halbiert. Betrifft Festkomma-
Rückfälle und Referenzbahnen. Für Karatsuba (ab 32 bzw. 48 Limbs) gesondert zu
prüfen.

### M7 – Innere Pixel früher beweisen (Hypothese)

Außerhalb von Kardioide und Periode-2-Scheibe endet ein inneres Pixel erst bei
bitgenauer Zustandswiederholung oder am Limit. Bei Multiplikator |λ| nahe 1
dauert das lange (|λ| = 0,99: etwa 3 600 Iterationen bis 2⁻⁵³). Exakte
Alternative: sobald ein Kandidat für die Periode p vorliegt, p Schritte mit
Kugelarithmetik rechnen (Radius r' = (2|z|+r)·r + Rundung). Bildet fᵖ eine Kugel
echt in sich ab, existiert ein anziehender Zyklus; er zieht den kritischen
Punkt an, also ist das Pixel für jedes Limit schwarz. Kein Epsilon-Vergleich,
gleiches Bild. **Offen:** zuerst messen, wie viele Iterationen in flachen
Bildern auf später schwarze Pixel entfallen; ohne diese Zahl ist der Nutzen unklar.

### M8 – Spiegelung an der reellen Achse (gemessen, Entscheidung nötig)

Vorhanden: `renderBands` in `web/view.js:120` rechnet gespiegelte Zeilen nur
einmal, wenn die Spiegelung Pixelmitten exakt auf Pixelmitten abbildet (flach
zusätzlich: exakt entgegengesetzte Doubles). Das ist korrekt und bitgenau.

Lücke: Nach freiem Zoomen ist `imag` praktisch nie ein Vielfaches des
Pixelabstands. Die Spiegelung greift dann nicht, obwohl die Achse im Bild liegt.
Sie wirkt heute nur in der Startansicht und bei Links mit y = 0.

Option: am Ende einer Navigation das Zentrum um höchstens ½ Pixel vertikal
einrasten, wenn die Achse im Bild liegt. Jedes Pixel bleibt exakt; es wird eine
um weniger als ½ Pixel verschobene Ansicht gerendert, und die URL zeigt das
eingerastete Zentrum. Ersparnis: min(a, H−a)/H der Zeilen (a = Zeile der Achse),
maximal 50 %. Das ändert die Abtastpositionen und ist deshalb eine
Produktentscheidung, keine reine Optimierung.

### M9 – Nicht entkommende Pixel am Cusp (keine Abkürzung gefunden)

In elefant, cusp32, links-ring sind die teuren Pixel Außenpunkte im
parabolischen Kanal, die innerhalb des Limits nicht entkommen. Die Kardioide
selbst ist zertifiziert und billig. BLA hilft dort nicht: der Gültigkeitsradius
ist an 2⁻⁴⁰ relative Linearitätsabweichung gebunden (`radius.e -= 40`, Zeile 457),
|δ| liegt darüber. Kandidaten für später: kleinerer Referenz-Fußabdruck (BLA-Radius
skaliert mit) und BLA zweiter Ordnung. Beides ungeprüft.

## 4. Ebene 2: programmiertechnisch

### P1 – Störungsrechnung in einfachen Doubles (Prototyp)

`Extended` (Mantisse plus eigener Exponent, Normalisierung nach jeder
Operation) ist nur nötig, wenn δ² unter den Double-Bereich fällt. Bei lokalen
Referenzen (e ≥ −79) liegen dc und δ² um Hunderte Binärstellen über der
Unterlaufgrenze 2⁻¹⁰²².
Skalierung mit Zweierpotenzen ist exakt, also rechnet der Double-Pfad dieselbe
Rekursion mindestens so genau (er verwirft keine kleinen Summanden).

Prototyp `perturb_pixel_f64` (`f64-prototype.patch`, rund 60 Zeilen, baut auf
M1 auf): identische Entscheidungen wie die `Extended`-Variante mit M1 (gleiche
Rückfall- und Iterationszähler), Pixel identisch zur Basis. Ergebnisse siehe
Tabelle in Abschnitt 2.

Abkürzungen im Prototyp, die eine Produktionsfassung beheben muss:

- Schranken werden mit Faktoren (1+2⁻⁵⁰) aufgebläht statt nach außen gerundet.
- |mag − 4| < 10⁻⁷ geht pauschal in den Rückfall statt in den Margin-Test.
- BLA-Schritte laufen weiter über `Extended` mit Umwandlung.
- Die Referenz wird bei jedem Zugriff aus `Extended` umgerechnet (`power_two`).

Weiteres Potenzial, noch nicht gehoben: Referenzbahn zusätzlich als Double-Felder
(und |Z| als Tabelle) ablegen, zwei Pixel pro `f64x2` verschränken. Ziel
1–2 ns pro Iteration statt 4,5. Für e < −79 dasselbe mit einem gemeinsamen
Skalierungsexponenten pro Pixel (reicht bis etwa 2⁻⁹⁰⁰).

**Risiko:** `docs/NOTES.md` dokumentiert ein entferntes f64-Experiment mit
Regressionen in Pfaden, die f64 gar nicht nutzten; die Ursache blieb offen.
Vermutung: Layout- und Registereffekte in der sehr großen Funktion (siehe A4).
Deshalb den neuen Pfad als eigene, nicht eingebettete Funktion bauen und den
vollen A/B-Vergleich aller 25 Regionen fahren.

### P2 – Double-Double-Kern verschränken (Hypothese, durch Assembler gestützt)

`dd_pixel_impl` (Zeile 524) rechnet ein Pixel skalar. Die Abhängigkeitskette
einer Iteration (Veltkamp-Produkt, zwei `dd_add`, Normalisierung) ist etwa
70 Zyklen lang; gemessen 17 ns. Der Prozessor kann aufeinanderfolgende
Iterationen nicht überlappen. Zwei Pixel pro `f64x2` und zwei Vektoren
nebeneinander, mit Nachfüllen wie in `render_stream`, sollten etwa 3× bringen,
bitidentisch pro Bahn. Nach M1 + P1 ist DD der größte Restposten (Elefant: rund
1,06 s von 2,09 s).

### P3 – Flacher Kern: mehr verschränkte Vektoren (Mikro-Benchmark)

`render_stream` (`core/mandelbrot.c:275`) ist latenzgebunden: die Kette
Multiplikation, Subtraktion, Addition dauert etwa 10 Zyklen, zwei Vektoren
füllen die Rechenwerke nicht. Nachbau des Kerns in `kern.c`, ns pro
Pixel-Iteration:

| Variante | ns |
| --- | ---: |
| skalar | 1,89 |
| 2 Vektoren, Test je Iteration (wie Produktion) | 0,52 |
| 3 Vektoren | 0,37 |
| 4 Vektoren | 0,35 |
| 4 Vektoren, ein `any_true` statt Bitmasken | 0,32 |
| 4 Vektoren, Sammelmaske, Test alle 8 Iterationen | 0,31 |

Der Blocktest bleibt exakt: Vergleichsmasken werden pro Iteration per ODER
gesammelt; schlägt der Test an, wird der Block vom gesicherten Zustand mit
Einzelprüfung wiederholt. Die Sammelmaske hält ein einmal erkanntes Entkommen
fest, auch wenn die Bahn danach nach unendlich oder NaN überläuft.

**Offen:** Acht Bahnen machen das Nachfüllen aufwendiger und lassen am
Kachelende mehr Bahnen leer laufen. Auf x86 (zwei FP-Multiplizierer) liegt das
Optimum vermutlich bei 3 Vektoren. Im echten Kern und auf x86 messen. Absolut
ist der flache Pfad schon schnell (0,02–0,2 s pro 4K-Bild).

### P4 – Pro-Pixel-Grundkosten im flachen Pfad (gemessen, niedrige Priorität)

Übersicht: 12,6 ns pro Pixel; reine Präfix-Kachel (alles entkommt in ≤ 4
Iterationen): 5,8 ns; zertifiziertes Inneres: 1,3 ns. Bei kurzen Bahnen
dominieren also skalares Präfix, Innentest und `colour` mit zwei Divisionen
(`colour_log2`, `core/mandelbrot.c:15`). Präfix und Innentest ließen sich
paarweise vektorisieren. Eine divisionsfreie Farbformel würde einzelne
Palettenindizes ändern und ist deshalb keine reine Optimierung.

### P5 – Limb-Multiplikation (Hypothese)

- `multiply_school` (Zeile 238) lädt `a[j]` in der inneren Schleife bei jedem
  Produkt neu (siehe A3). `uint64_t aj=a[j]` vor der Schleife oder `restrict`
  behebt das.
- Die Übertragskette (Addition, Addition, Schieben) ist seriell. Spaltenweise
  Akkumulation mit getrennten 64-Bit-Summen für Low- und High-Hälften entkoppelt
  die Produkte; mit `i64x2.extmul_low_i32x4_u` gibt es zwei Produkte pro Befehl.
  Ganzzahlprodukte sind eindeutig, das Ergebnis bleibt bitidentisch.
- Zusammen mit M5 und M6 zu bewerten; ohne Festkomma-Rückfälle ist der Posten klein.

## 5. Ebene 3: WASM-Assembler

Grundlage: `build/internal/wasm/engine-simd.s` (Clang `-O3 -msimd128
-ffp-contract=off`, `build-support/scripts/build.sh:182`). Das ist der
WASM-Code, den V8 erhält, nicht der von V8 erzeugte Maschinencode.

### A1 – Flache Stromschleife (`render_tile`, Zeilen 1530–1636)

Pro Iteration: 6 `f64x2.mul`, 8 `f64x2.add`, 2 `f64x2.sub`, 2 `f64x2.gt`,
2 `i64x2.bitmask`, ein `i64`-Zähler, zwei Sprünge. Die Fließkommafolge ist
minimal; es gibt keine überflüssige Rechenoperation.

Auffällig: LLVM führt acht zusätzliche `i32`-Schleifenzähler mit (Zeilen
1531–1562, je ein Dekrement pro Iteration). Es sind vorgezogene Formen von
`tick − start[lane]`, die erst nach der Schleife gebraucht werden. Gemessen
kostet das nichts: der Produktionskern erreicht 0,497 ns, der Nachbau ohne
diese Zähler 0,52 ns. Die Schleife wartet auf die Fließkommakette, nicht auf
Ganzzahlbefehle. Kein Handlungsbedarf, solange es bei zwei Vektoren bleibt; bei
vier Vektoren (P3) erneut prüfen.

### A2 – Double-Double-Schleife (`uncertain_pixel`, Zeilen 60288–60776)

Die Produktionsvariante (ohne `DEEP_DD_CACHE`) enthält 40 `f64.mul`, 84
`f64.add`, 46 `f64.sub`, eine Wurzel und 10 bedingte Sprünge: fünf DD-Produkte
pro Iteration, obwohl drei genügen. Die Cache-Variante (Zeilen 59673–60091) hat
28/67/43. LLVM entfernt die doppelten Quadrate also nicht.

Das erklärt den Befund in `docs/NOTES.md`, dass `DEEP_DD_CACHE` trotz weniger
Produkten langsamer war: die Schleife ist latenzgebunden, die eingesparten
Produkte lagen nicht auf der kritischen Kette. Sobald mehrere Pixel verschränkt
laufen (P2), wird die Schleife durchsatzgebunden, und der Cache spart rund 19 %
der Operationen. Dann neu messen.

### A3 – Limb-Multiplikation (`multiply_big`, Zeilen 38810–38864)

Innere Schleife, zweifach abgerollt: 26 WASM-Befehle pro 32×32-Produkt, davon
drei Ladebefehle (`a[j]`, `b[k]`, `out[j+k]`). `a[j]` wird jedes Mal neu
geladen, weil ein Alias mit `out` nicht ausgeschlossen ist. Die Kette
`carry → add → add → store32/shr → carry` ist seriell.

### A4 – `Extended`-Störungsschleife (`render_deep_tile`, Zeilen 26960–36862)

Der Schleifenkörper umfasst 8 644 WASM-Befehle: 335 `f64.mul`, 350 bedingte
Sprünge, 126 Bit-Umdeutungen zwischen `f64` und `i64` (Exponent lesen,
Zweierpotenz bauen), 9 Wurzeln, 4 Divisionen. Das ist der Preis von rund 25
Normalisierungen pro Iteration und entspricht den gemessenen 35 ns. Die ganze
Funktion ist 12 800 Zeilen lang, weil alles eingebettet wird (Serie, BLA,
lokale Referenz, Rückfälle).

**Offen:** Ob V8 eine so große Funktion schlechter optimiert (Registerzuteilung,
Aufwärmzeit bis zur optimierten Stufe), ist nicht untersucht. Test: heiße
Schleifen per `noinline` auslagern und A/B messen.

### A5 – Nicht untersucht: der echte Maschinencode

Was V8 aus dem WASM macht (ARM64 und x64), habe ich nicht gesehen. Relevante
Fragen: Wie teuer ist `i64x2.bitmask` auf ARM64 (kein `movmsk`), bleiben die
Vektoren in Registern, wie werden `f64.reinterpret` übersetzt? Wege: ein
d8-Debug-Build mit `--print-wasm-code`, Linux `perf` mit `--perf-prof`, oder als
Näherung derselbe C-Kern nativ mit `clang -O3 -S` für arm64 und x86-64.

## 6. Geprüft, ohne Gewinn

- Acht überflüssige Zähler in der flachen Schleife: messbar wirkungslos (A1).
- Absolutes statt relatives Fehlerkriterium: mehr Rückfälle (M2).
- Referenzbahn und Karatsuba-Schwellen im mittleren Bereich: Referenziterationen
  liegen dort unter 0,1 % der Arbeit.
- Bitmasken durch `any_true` ersetzen bei zwei Vektoren: 2–3 %.

## 7. Arbeitspakete für die Detailanalyse

1. **M1 beweisen und übernehmen.** Beweis schreiben (inklusive BLA-Zweig),
   `tests/numerical-oracle.js` und volle 4K-A/B-Läufe aller 25 Regionen.
2. **P1 als Produktionspfad.** Eigene Funktion, Außenrundung, Margin-Test,
   BLA in Doubles, Double-Felder für die Referenz. Danach SIMD über zwei Pixel.
   Abbruchkriterium laut NOTES: Regression in irgendeinem Referenzfall.
3. **P2 DD-Kern verschränken**, danach `DEEP_DD_CACHE` neu bewerten (A2).
4. **M4 Rückfallstufen.** DD-Schwelle aus e ableiten; DD-δ-Störungsrechnung
   für e < −80 entwerfen; nähere Referenz für Rückfallpixel prüfen.
5. **M5/M6/P5 Limb-Arithmetik.** Erst Wiederholungsrate gegen Startpräzision
   messen, dann Kurzprodukt und spaltenweise Akkumulation.
6. **preperiodic-1600 gezielt profilieren.** Die Stichprobe (5 Kacheln) traf
   keine Rückfallkachel; die 853 s des Vollbilds stammen vermutlich aus wenigen
   Kacheln mit Festkomma-Rückfällen bei 109 Limbs. Kacheln nach Zeit sortieren.
7. **M3 Rundungskonstante** für den Double-Pfad herleiten.
8. **P3 flacher Kern** mit 3 und 4 Vektoren im echten `render_stream`, auch x86.
9. **M7 Kugelzertifikat**: vorab Iterationsanteil schwarzer Pixel messen.
10. **M8 Einrasten**: Entscheidung, ob die Ansicht um < ½ Pixel verschoben werden darf.
11. **A5 Maschinencode** von V8 für die drei heißen Schleifen ansehen.

## 8. Reproduktion

    make web
    cd build/internal/optimization-analysis
    # Variante bauen: Verzeichnis mit core/ und web/native/, Patch anwenden
    ./build-variant.sh <verzeichnis> <ausgabe.wasm>
    # Stichprobe; DUMP=<präfix> hängt die Kachelpixel an <präfix>-<region>.bin an
    # (vor einem neuen Lauf löschen)
    WASM=<basis.wasm>    STRIDE=53 DUMP=/tmp/a node sample.mjs cusp24 elefant
    WASM=<variante.wasm> STRIDE=53 DUMP=/tmp/b node sample.mjs cusp24 elefant
    node cmp.mjs /tmp/a-cusp24.bin /tmp/b-cusp24.bin
    node kern.mjs        # Mikro-Benchmark flacher Kern
    node shallow2.mjs    # ns pro Pixel-Iteration des Produktionskerns

`build-variant.sh` und `sample.mjs` enthalten absolute Pfade auf dieses
Projektverzeichnis.
