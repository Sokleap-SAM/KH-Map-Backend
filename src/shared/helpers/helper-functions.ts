/** Coordinate pair: [longitude, latitude] */
export type Coords = [number, number];

/** Haversine distance between two [lng, lat] points (meters). */
export function haversineMeters(
  [lng1, lat1]: Coords,
  [lng2, lat2]: Coords,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Total length (meters) of a polyline, summed across consecutive segments. */
export function polylineLengthMeters(coords: Coords[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1], coords[i]);
  }
  return total;
}

/** Convert a walking distance (meters) to minutes at `walkSpeedKmh`. */
export function walkMinutes(
  distanceMeters: number,
  walkSpeedKmh: number,
): number {
  return (distanceMeters / 1000 / walkSpeedKmh) * 60;
}

/**
 * Shortest distance (meters) from point P to line segment AB.
 * Coordinates are [lng, lat]; approximated as planar (fine for short segments).
 */
export function pointToSegmentDistance(
  p: Coords,
  a: Coords,
  b: Coords,
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return haversineMeters(p, a);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy),
    ),
  );
  return haversineMeters(p, [a[0] + t * dx, a[1] + t * dy]);
}

/** Compass heading (degrees, 0–360) from point `from` to point `to`. */
export function computeHeading(
  [lng1, lat1]: Coords,
  [lng2, lat2]: Coords,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/**
 * Binary min-heap used as a priority queue in Dijkstra's algorithm.
 * O(log n) push/pop — much faster than Array.sort() for large graphs.
 */
export class MinHeap {
  private readonly data: Array<[number, string]> = [];

  push(item: [number, string]): void {
    this.data.push(item);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): [number, string] | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  get size(): number {
    return this.data.length;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[parent][0] <= this.data[i][0]) break;
      [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    for (;;) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left][0] < this.data[smallest][0])
        smallest = left;
      if (right < n && this.data[right][0] < this.data[smallest][0])
        smallest = right;
      if (smallest === i) break;
      [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
      i = smallest;
    }
  }
}
