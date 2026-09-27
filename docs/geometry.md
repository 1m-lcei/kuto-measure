# Geometry and state boundaries

## Four spaces

Client coordinates are CSS pixels from Pointer Events. Image coordinates are
decoded intrinsic pixels, with the origin at the top left, X right and Y down.
Ground coordinates are orthonormal coordinates on one plane, initially in arbitrary
units. Game coordinates are Ground coordinates multiplied by one positive scale.
Branded point/distance types distinguish these spaces at module boundaries.

The viewport owns only zoom, fit and native scroll offsets. DOM code snapshots the
stage's client origin. `clientToImage = (client - origin) / zoom`; scroll offsets
are already included in the origin. Device pixel ratio does not enter this mapping.

Pins and free centers are stored in Ground space. No rounded image coordinates,
centroids, distance labels, scales or sampled SVG paths are stored in the document.
Group membership exists only as a pin's `groupId`. Centroids are Ground arithmetic
means, and endpoint references resolve against the current document.

## Shared camera, per-image render area

`CameraCalibration` defaults to pitch (`elevationDegrees`, 25.2° downward from horizontal), roll (0°), vertical FOV (9.92°),
and principal-point fractions (0.5, 0.5). It contains no screenshot dimensions
or pixel-space vanishing points. The measurement evidence is in
`calibration/range-2026-09-26.json`. See `calibration/README.md` for limitations.

The camera has square pixels, zero skew and no lens distortion. A shared camera
and constant vertical FOV are assumptions: aspect changes alter horizontal
coverage, while recognized borders sit outside the game viewport. This is not
a claim that every game mode/device has been empirically verified.

On image decode, a small Canvas sample identifies paired nearly uniform solid
or blue patterned borders. Similar opposite borders between 1% and 22% of the
image dimension are accepted; ambiguous/asymmetric borders retain the full
image on that axis. If horizontal detection fails, a blue-band fallback samples
the outer quarters of each row, ignoring the central home indicator. It requires
at least 70% blue pixels in those samples after rejecting RGB outliers more than
32 from the per-channel median. It then requires low color variance, and searches
past at most 4% of image height in outer chrome for paired bands of similar thickness.
Sampling is bounded at 256 × 1024 pixels and the temporary Canvas is released.
No image is uploaded. Resolution independence requires the correct render area
and the shared-camera assumptions. Large player frames or ambiguous bands need
manual bounds. A full-image automatic result is a fallback, not proof of no borders.
The document stores the effective bounds, their source (`auto`, `manual`, `full`,
or `fallback`), and a separate `confirmed` flag together with the ground data.
Every new image starts unconfirmed, including successfully detected bands. The image resource keeps the original
automatic result for restoring automatic mode. The reference panel provides integer
top/bottom/left/right insets, validated to leave at least one pixel on each axis.
Draft bounds only draw a preview; they never change projection or export.
See [the measurement guide](measurement.md) for observed failures and diagnostic steps.

For detected render area `(x, y, width, height)` and normalized principal `(u,v)`:

```text
f  = height / (2 * tan(verticalFov / 2))
cx = x + u * width; cy = y + v * height
K  = [[f, 0, cx], [0, f, cy], [0, 0, 1]]
e1 = (cos(roll), sin(roll), 0)
e2 = (-sin(roll)*sin(elevation), cos(roll)*sin(elevation), -cos(elevation))
n  = e1 × e2
```

Scaling the render area scales `f` and the principal position. Adding borders
translates the principal point without changing `f`. Changing only viewport
width changes horizontal coverage without changing `f`. Arbitrary post-capture
crops cannot be inferred from dimensions alone and are outside this policy.

Camera axes are X right, Y down, Z forward. Choose camera height 1 in arbitrary
Ground units: the plane is `n · P = 1`. The Ground origin is the intersection of
the optical axis and plane, `O = (0, 0, 1/n.z)`.

```text
P = O + ground.x * e1 + ground.y * e2
image = (cx + f*P.x/P.z, cy + f*P.y/P.z)
H = K [e1 e2 O]
```

For inverse projection, `ray = ((x-cx)/f, (y-cy)/f, 1)`,
`P = ray / dot(n, ray)`, and Ground coordinates are dot products of `P-O` with
e1 and e2. This directly implements the inverse homography without a matrix library.
The ground basis is independent of the stage's rail/tile orientation. Rotating
the ground coordinate axes does not change circles, distances or centroids.
Pins/centers cannot be placed in detected borders, and annotations are clipped
to the render area. PNG export retains the entire original image and its borders.

## Why not screen distances?

Perspective divides by depth. Equal Ground segments at different image heights
project to different pixel lengths.
Measuring these screen lengths would give different answers for the same distance.
Inverse-project endpoints first, compute Euclidean Ground distance, then apply scale.

The reference circle supplies only `scale = knownGameRadius / radiusGround`.
It does not estimate camera orientation. Moving it preserves Ground radius; resizing
it changes scale. Pins remain fixed in Ground space. Guide circles keep their entered
Game radius and derive `radiusGround = radiusGame / scale` on every render.

Without a configured reference radius, use `scale = 1 / firstMeasurementGroundLength`.
The first remaining measurement is always one; moving its endpoints updates all
relative distances, and deleting it promotes the next measurement. A zero-length
first line or an empty endpoint group leaves the document uncalibrated. Reference
calibration takes priority. The shared scale also applies to guide circles and PNG export.

## Circles and numerical limits

Sample true Ground circles `center + r*(cos θ, sin θ)` and project each point.
Do not interpret their image bounds as independently editable ellipse axes.
Start with 16 arcs; subdivide until projected midpoint-to-chord error is at most
0.5 CSS px on screen or 0.25 intrinsic px for export. Depth 8 per arc caps the
circle at 4096 vertices; emit a precision notice when the cap is reached.

Reject non-finite inputs, invalid viewport bounds/FOV/elevation, non-positive radii, nearly horizontal
optical-plane intersections (`n.z < 1e-6`), and inverse rays with `n·ray <= 1e-9`.
Forward points require Z > 1e-6. The entire circle must satisfy:

```text
O.z + center.x*e1.z + center.y*e2.z - r*hypot(e1.z, e2.z) > 1e-6
```

Circles may extend outside the image, which SVG clips. Invalid attached circles are
retained and listed but not drawn. Invalid reference edits are rejected. An empty
group has no center; its dependent objects remain suspended until it has members.

## Transactions and export

Advanced settings expose the camera parameters in the reference panel. A calibration
or render-area edit reprojects pins and free centers through their old image positions into the new
Ground plane. The reference circle keeps its projected center and uses the distance
to its remapped old +X rim point as its new radius; its full outline is not preserved.
Known Game radii remain unchanged, and group centers and scale are derived again.
Invalid point mappings or reference circles reject the entire edit. Calibration,
render-area bounds/source and remapped geometry share one history snapshot, including Undo/Redo.
Source-only changes skip remapping. Out-of-area anchors remain stored but annotations
are clipped; invalid ground mappings reject the whole edit. The projection is
rebuilt from the current document for display and export. Loading another image uses
the explicitly saved reference circle and camera, or defaults if none is usable.
The saved preset contains no image dimensions or render area. It must pass schema,
numeric, forward-circle and in-frame-center checks before becoming the new document's
initial state. Automatic application does not create an Undo step or count as unsaved
editing. Resetting the current reference removes the old circle before remapping the
remaining anchors to the default camera, in one reversible edit. Preset storage is
independent of document history. Resetting the reference preserves the current area,
and saving a reference validates it against that effective area. Hiding advanced
settings only hides controls. Area controls use a native disclosure, initially collapsed.
Unconfirmed areas show a compact red notice below the image dimensions, even when
the reference panel closes. OK marks the current bounds confirmed without remapping
geometry; applying automatic, manual or full-image bounds also confirms them. The
confirmation flag participates in history but alone does not trigger a discard-edits
prompt on image replacement. The settings button opens both disclosures and focuses
the first area input. Full-image bounds display "画像全体" with the aspect ratio instead of
repeating pixel dimensions. Editing and PNG export remain available.

`applyEdit` is a pure transition. A drag previews changes against its starting
document, commits once on release, and discards them on Escape/capture loss/resize.
The history contains at most 100 immutable document snapshots; image resources and
viewport state never enter it. Direct references are removed atomically on deletion.

SVG rendering is shared with PNG output. Export freezes the current document,
renders at zoom 1 without controls, and draws the original raster plus a standalone
annotation SVG to Canvas. Output dimensions and annotation sizes are independent
of viewport, pan, zoom, browser DPR and UI theme.

Labels are derived presentation, not measurement coordinates. A bounded greedy layout
uses measured text bounds in CSS pixels, moving labels and adding non-interactive leader
lines. PNG runs the same layout at zoom 1. Label clicks select their owners; dragging a
label never moves its underlying ground point. Hover and pin-tool dimming remain UI-only.

See the executable geometry/state tests and production-browser checks for invariants.

## References

- [Orthogonal vanishing-point constraint](https://www.andrew.cmu.edu/course/16-822/projects/kaustavm/proj2/)
- [Camera modeling and calibration](https://visionbook.mit.edu/imaging_geometry.html)
- [SVG non-scaling strokes](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/vector-effect)
