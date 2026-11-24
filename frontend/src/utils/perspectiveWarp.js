// Geometry helpers shared by the live overlay and capture gates.

// Quad area as a fraction of the normalised frame, for the size gate.
export function quadAreaFraction(corners) {
  if (!corners || corners.length !== 4) return 0
  let area = 0
  for (let i = 0; i < corners.length; i += 1) {
    const [x1, y1] = corners[i]
    const [x2, y2] = corners[(i + 1) % corners.length]
    area += x1 * y2 - x2 * y1
  }
  return Math.abs(area) * 0.5
}
