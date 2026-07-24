import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  BusRouteStop,
  BusRouteStopDocument,
  GeoJsonLineString,
} from './entities/bus-route-stop.schema';
import { BusRoute, BusRouteDocument } from './entities/bus-route.schema';
import { Place, PlaceDocument } from '../places/entities/place.schema';
import { CreateBusRouteStopDto } from './dto/create-bus-route-stop.dto';
import { UpdateBusRouteStopDto } from './dto/update-bus-route-stop.dto';
import { BulkBusRouteStopsDto } from './dto/bulk-bus-route-stops.dto';
import {
  haversineMeters,
  polylineLengthMeters,
} from '../../shared/helpers/helper-functions';
import { ValhallaService } from './valhalla.service';

type LngLat = [number, number];

/** Last vertex of a stored segment, or null when the stop has no segment. */
function lastVertex(seg?: GeoJsonLineString | null): LngLat | null {
  const c = seg?.coordinates;
  return c && c.length > 0 ? (c[c.length - 1] as LngLat) : null;
}

// ─── Segment-stitching thresholds ────────────────────────────────────────────
// Segments are road-snapped independently; consecutive Valhalla calls snap the
// shared stop to the same road point, so gaps only appear when an admin
// override steered one segment onto a different road (or a divided-road snap
// picked the other carriageway).
/** Gaps up to this are bridged with a straight vertex — invisible at map zoom. */
const STITCH_PREPEND_MAX_M = 10;
/** Gaps up to this get a Valhalla road connector so curves are respected. */
const STITCH_CONNECTOR_MAX_M = 300;
/** A connector longer than gap × this factor means the segment likely ends on
 *  the wrong side of a divided road (the car route is a U-turn loop) — reject
 *  so the admin fixes the drawing instead of silently storing a detour. */
const STITCH_CONNECTOR_DETOUR_FACTOR = 5;

@Injectable()
export class BusRouteStopService {
  private readonly logger = new Logger(BusRouteStopService.name);

  constructor(
    @InjectModel(BusRouteStop.name)
    private readonly busRouteStopModel: Model<BusRouteStopDocument>,
    @InjectModel(BusRoute.name)
    private readonly busRouteModel: Model<BusRouteDocument>,
    @InjectModel(Place.name)
    private readonly placeModel: Model<PlaceDocument>,
    private readonly valhallaService: ValhallaService,
  ) {}

  // ─── Segment helpers ─────────────────────────────────────────────────────

  /**
   * Road-snapped polyline between two stop locations via Valhalla
   * `costing=auto`, optionally steered through `vias`. The returned shape
   * starts/ends at the ROAD nearest each stop — the raw stop coordinates
   * (which sit on the sidewalk) are never part of the path.
   */
  private async buildRoadSegment(
    from: LngLat,
    to: LngLat,
    vias: LngLat[] = [],
  ): Promise<LngLat[]> {
    const result = await this.valhallaService.getAutoPath(from, to, vias);
    if (!result || result.path.length < 2) {
      throw new ServiceUnavailableException(
        `Could not compute a road path between [${from.join(',')}] and [${to.join(',')}] — routing engine unavailable or no drivable road between the stops.`,
      );
    }
    return result.path as LngLat[];
  }

  /**
   * Ensure `path` connects to the previous segment's end. Tiny gaps get a
   * straight bridge vertex; moderate gaps get a Valhalla road connector so
   * curved roads aren't cut across. When the connector is disproportionate
   * (opposite side of a divided road → the legal car route is a huge U-turn
   * loop) or Valhalla is unavailable, we fall back to the straight bridge
   * instead of rejecting: the admin is often mid-correction — fixing one
   * wrongly-drawn segment at a time — and blocking the save would trap the
   * chain in its broken state. Only truly disconnected drawings (> 300 m)
   * are rejected.
   */
  private async stitchToPrevious(
    prevEnd: LngLat | null,
    path: LngLat[],
  ): Promise<LngLat[]> {
    if (!prevEnd) return path;
    const gap = haversineMeters(prevEnd, path[0]);
    if (gap < 1) return path;
    if (gap <= STITCH_PREPEND_MAX_M) return [prevEnd, ...path];
    if (gap <= STITCH_CONNECTOR_MAX_M) {
      const connector = await this.valhallaService.getAutoPath(
        prevEnd,
        path[0],
      );
      const usable =
        connector &&
        connector.path.length >= 2 &&
        connector.distanceMeters <= gap * STITCH_CONNECTOR_DETOUR_FACTOR;
      return usable
        ? [...(connector.path as LngLat[]), ...path]
        : [prevEnd, ...path];
    }
    throw new BadRequestException(
      `Segment does not connect: it starts ${Math.round(gap)} m away from the previous segment's end (max ${STITCH_CONNECTOR_MAX_M} m). Fix the drawing or omit the polyline to let the backend compute it.`,
    );
  }

  /** Resolve a Place's [lng, lat] or throw 400. */
  private async placeCoords(placeId: Types.ObjectId): Promise<LngLat> {
    const place = await this.placeModel
      .findById(placeId)
      .select('location')
      .lean()
      .exec();
    if (!place) {
      throw new BadRequestException(`Place ${placeId.toString()} not found`);
    }
    return place.location.coordinates as LngLat;
  }

  /**
   * Coordinates of a route-stop's populated Place, or a 400 explaining that
   * the referenced Place was deleted. Dangling refs are a known reality —
   * Places can be removed while route-stops still point at them (the routing
   * network silently filters such stops; the editor must surface them).
   */
  private populatedCoords(
    doc: { stop?: { location?: { coordinates: LngLat } } | null },
    label: string,
  ): LngLat {
    const coords = doc.stop?.location?.coordinates;
    if (!coords) {
      throw new BadRequestException(
        `${label} references a Place that no longer exists (it was deleted). Repair that stop with PATCH { stop: <newPlaceId> } or delete it first.`,
      );
    }
    return coords;
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────

  async create(dto: CreateBusRouteStopDto): Promise<BusRouteStop> {
    let segmentPath: GeoJsonLineString | undefined;
    let distanceFromPrevious: number | null = dto.distanceFromPrevious ?? null;

    if (dto.stopOrder > 1) {
      // Find previous stop (stopOrder - 1) on the same route, populated with place
      const prevStop = await this.busRouteStopModel
        .findOne({ route: dto.route, stopOrder: dto.stopOrder - 1 })
        .populate<{ stop: { location: { coordinates: LngLat } } }>('stop')
        .exec();

      if (!prevStop) {
        throw new BadRequestException(
          `No stop found with stopOrder ${dto.stopOrder - 1} on this route. Add stops in order.`,
        );
      }

      const prevCoords = this.populatedCoords(
        prevStop,
        `Previous stop (stopOrder ${dto.stopOrder - 1})`,
      );
      const currCoords = await this.placeCoords(dto.stop);

      // Admin-approved polyline wins when provided; otherwise Valhalla
      // computes the road path (optionally steered through vias). The raw
      // stop coordinates are never glued onto the ends — stops live on the
      // sidewalk, the path lives on the road.
      let coordinates =
        dto.waypoints && dto.waypoints.length >= 2
          ? dto.waypoints
          : await this.buildRoadSegment(prevCoords, currCoords, dto.vias ?? []);
      coordinates = await this.stitchToPrevious(
        lastVertex(prevStop.segmentPath),
        coordinates,
      );

      segmentPath = { type: 'LineString', coordinates };
      distanceFromPrevious =
        dto.distanceFromPrevious ?? polylineLengthMeters(coordinates);
    } else if (
      (dto.waypoints && dto.waypoints.length > 0) ||
      (dto.vias && dto.vias.length > 0)
    ) {
      throw new BadRequestException(
        'First stop has no incoming segment — waypoints/vias are not allowed on stopOrder 1.',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { waypoints: _w, vias: _v, ...rest } = dto;
    return this.busRouteStopModel.create({
      ...rest,
      segmentPath,
      distanceFromPrevious,
    });
  }

  async findByRoute(routeId: Types.ObjectId): Promise<BusRouteStop[]> {
    return this.busRouteStopModel
      .find({ route: routeId })
      .sort({ stopOrder: 1 })
      .populate('stop')
      .exec();
  }

  async findRoutesByStop(stopId: Types.ObjectId): Promise<BusRouteStop[]> {
    return this.busRouteStopModel
      .find({ stop: stopId })
      .populate('route')
      .exec();
  }

  async findOne(id: Types.ObjectId): Promise<BusRouteStop> {
    const routeStop = await this.busRouteStopModel
      .findById(id)
      .populate('stop')
      .populate('route')
      .exec();
    if (!routeStop)
      throw new NotFoundException(`BusRouteStop ${id.toString()} not found`);
    return routeStop;
  }

  /**
   * Fix a single stop in place. Two supported mistake types:
   *
   *   - Wrong road: send `vias` (backend recomputes through them) or
   *     `waypoints` (full replacement polyline from suggest-path). The next
   *     stop's segment is re-stitched to the new endpoint automatically.
   *   - Wrong place: send a new `stop` — BOTH the incoming and outgoing
   *     segments are recomputed via Valhalla from the new location.
   *
   * `stopOrder` and `route` cannot be changed here (delete + re-create at
   * the right position instead) — allowing them would silently invalidate
   * every neighbouring segment.
   *
   * Returns the updated stop; the caller must invalidate the routing
   * network cache and evict the simulator's route cache.
   */
  async update(
    id: Types.ObjectId,
    dto: UpdateBusRouteStopDto,
  ): Promise<BusRouteStop> {
    const existing = await this.busRouteStopModel.findById(id).exec();
    if (!existing)
      throw new NotFoundException(`BusRouteStop ${id.toString()} not found`);

    if (dto.stopOrder !== undefined && dto.stopOrder !== existing.stopOrder) {
      throw new BadRequestException(
        'stopOrder cannot be changed via update — delete the stop and re-create it at the desired position.',
      );
    }
    if (dto.route && String(dto.route) !== String(existing.route)) {
      throw new BadRequestException(
        'route cannot be changed via update — delete the stop and re-create it on the target route.',
      );
    }

    const stopChanged =
      dto.stop !== undefined && String(dto.stop) !== String(existing.stop);
    const geometryProvided =
      (dto.waypoints && dto.waypoints.length >= 2) ||
      (dto.vias && dto.vias.length > 0);

    const update: Record<string, unknown> = {};
    if (dto.stop !== undefined) update.stop = dto.stop;
    if (dto.distanceFromPrevious !== undefined) {
      update.distanceFromPrevious = dto.distanceFromPrevious;
    }

    if (stopChanged || geometryProvided) {
      const routeId = existing.route!;
      const order = existing.stopOrder!;
      const thisCoords = await this.placeCoords(dto.stop ?? existing.stop!);

      const prevDoc = await this.busRouteStopModel
        .findOne({ route: routeId, stopOrder: order - 1 })
        .populate<{ stop: { location: { coordinates: LngLat } } }>(
          'stop',
          'location',
        )
        .exec();
      const nextDoc = await this.busRouteStopModel
        .findOne({ route: routeId, stopOrder: order + 1 })
        .populate<{ stop: { location: { coordinates: LngLat } } }>(
          'stop',
          'location',
        )
        .exec();

      // ── Incoming segment (prev → this) ──────────────────────────────────
      let newIncomingEnd: LngLat | null = lastVertex(existing.segmentPath);
      if (order > 1) {
        if (!prevDoc) {
          throw new BadRequestException(
            `Route ordering is corrupt: no stop at stopOrder ${order - 1}.`,
          );
        }
        const prevCoords = this.populatedCoords(
          prevDoc,
          `Previous stop (stopOrder ${order - 1})`,
        );
        let coordinates =
          dto.waypoints && dto.waypoints.length >= 2
            ? dto.waypoints
            : await this.buildRoadSegment(
                prevCoords,
                thisCoords,
                dto.vias ?? [],
              );
        coordinates = await this.stitchToPrevious(
          lastVertex(prevDoc.segmentPath),
          coordinates,
        );
        update.segmentPath = { type: 'LineString', coordinates };
        update.distanceFromPrevious =
          dto.distanceFromPrevious ?? polylineLengthMeters(coordinates);
        newIncomingEnd = coordinates[coordinates.length - 1];
      } else if (geometryProvided) {
        throw new BadRequestException(
          'First stop has no incoming segment — waypoints/vias are not allowed on it.',
        );
      }

      // ── Outgoing segment (this → next), stored on the NEXT stop ─────────
      if (nextDoc) {
        const nextCoords = this.populatedCoords(
          nextDoc,
          `Next stop (stopOrder ${order + 1})`,
        );
        if (stopChanged) {
          // The stop moved to a different place — the old outgoing polyline
          // is meaningless. Recompute from the new location.
          let outgoing = await this.buildRoadSegment(thisCoords, nextCoords);
          outgoing = await this.stitchToPrevious(newIncomingEnd, outgoing);
          await this.busRouteStopModel
            .updateOne(
              { _id: nextDoc._id },
              {
                $set: {
                  segmentPath: { type: 'LineString', coordinates: outgoing },
                  distanceFromPrevious: polylineLengthMeters(outgoing),
                },
              },
            )
            .exec();
        } else if (update.segmentPath && newIncomingEnd) {
          // Geometry-only change: keep the next segment's road shape but
          // re-stitch its start to the incoming segment's new endpoint.
          const nextPath = nextDoc.segmentPath?.coordinates as
            | LngLat[]
            | undefined;
          if (nextPath && nextPath.length >= 2) {
            const stitched = await this.stitchToPrevious(
              newIncomingEnd,
              nextPath,
            );
            if (stitched !== nextPath) {
              await this.busRouteStopModel
                .updateOne(
                  { _id: nextDoc._id },
                  {
                    $set: {
                      segmentPath: {
                        type: 'LineString',
                        coordinates: stitched,
                      },
                      distanceFromPrevious: polylineLengthMeters(stitched),
                    },
                  },
                )
                .exec();
            }
          }
        }
      }
    }

    const routeStop = await this.busRouteStopModel
      .findByIdAndUpdate(id, update, { new: true })
      .populate('stop')
      .exec();
    if (!routeStop)
      throw new NotFoundException(`BusRouteStop ${id.toString()} not found`);
    return routeStop;
  }

  /**
   * Delete one stop and heal the chain around the hole:
   *
   *   - Middle stop: the next stop's segment is recomputed as the road path
   *     from the previous stop directly to it (admin can PATCH it with vias
   *     afterwards if Valhalla's default road is wrong).
   *   - First stop: the next stop becomes first — its segment is cleared.
   *   - Last stop: plain delete.
   *
   * Later stops' `stopOrder` values are shifted down so the sequence stays
   * contiguous. The heal segment is computed BEFORE the delete so a Valhalla
   * outage aborts the whole operation instead of leaving a broken chain.
   *
   * Returns the routeId so the caller can invalidate caches.
   */
  async remove(id: Types.ObjectId): Promise<{ routeId: string }> {
    const doc = await this.busRouteStopModel.findById(id).exec();
    if (!doc)
      throw new NotFoundException(`BusRouteStop ${id.toString()} not found`);

    const routeId = doc.route!;
    const order = doc.stopOrder!;

    const prevDoc = await this.busRouteStopModel
      .findOne({ route: routeId, stopOrder: order - 1 })
      .populate<{ stop: { location: { coordinates: LngLat } } }>(
        'stop',
        'location',
      )
      .exec();
    const nextDoc = await this.busRouteStopModel
      .findOne({ route: routeId, stopOrder: order + 1 })
      .populate<{ stop: { location: { coordinates: LngLat } } }>(
        'stop',
        'location',
      )
      .exec();

    // Compute the heal BEFORE deleting anything: a Valhalla outage must
    // abort the delete rather than leave the chain broken.
    let nextUpdate: Record<string, unknown> | null = null;
    if (nextDoc) {
      if (prevDoc) {
        const prevCoords = this.populatedCoords(
          prevDoc,
          `Previous stop (stopOrder ${order - 1})`,
        );
        const nextCoords = this.populatedCoords(
          nextDoc,
          `Next stop (stopOrder ${order + 1})`,
        );
        let healed = await this.buildRoadSegment(prevCoords, nextCoords);
        healed = await this.stitchToPrevious(
          lastVertex(prevDoc.segmentPath),
          healed,
        );
        nextUpdate = {
          segmentPath: { type: 'LineString', coordinates: healed },
          distanceFromPrevious: polylineLengthMeters(healed),
        };
      } else {
        // Deleted the first stop — the next stop becomes the route head.
        nextUpdate = { segmentPath: null, distanceFromPrevious: null };
      }
    }

    await this.busRouteStopModel.findByIdAndDelete(id).exec();

    if (nextDoc && nextUpdate) {
      await this.busRouteStopModel
        .updateOne({ _id: nextDoc._id }, { $set: nextUpdate })
        .exec();
    }

    // Close the stopOrder hole. Shift ascending, one at a time — the unique
    // (route, stopOrder) index forbids a bulk $inc whose internal order is
    // undefined (5→4 before 4→3 would transiently collide).
    const laterDocs = await this.busRouteStopModel
      .find({ route: routeId, stopOrder: { $gt: order } })
      .sort({ stopOrder: 1 })
      .select('_id')
      .exec();
    for (const later of laterDocs) {
      await this.busRouteStopModel
        .updateOne({ _id: later._id }, { $inc: { stopOrder: -1 } })
        .exec();
    }

    return { routeId: routeId.toString() };
  }

  /**
   * Bulk-create stops on a route from an ordered list of places picked by
   * the admin on a map.
   *
   *   - If `routeId` is provided the new stops are appended after the existing
   *     ones; the first new stop's segment routes from the previous tail.
   *   - If `routeId` is omitted a new BusRoute is created from the metadata
   *     fields and stops start at stopOrder=1 with the first stop's
   *     segmentPath left null (no incoming segment).
   *
   * Segment geometry per non-first stop:
   *   - `segmentFromPrevious` provided → stored verbatim (admin approved it
   *     via suggest-path, optionally steered with vias there).
   *   - omitted → the backend computes the road path via Valhalla itself,
   *     optionally steered through the item's `vias`.
   * Either way the raw stop coordinates never enter the polyline, and every
   * segment is stitched to the previous one's endpoint.
   *
   * On any failure we roll back every doc this call created so the route is
   * never left half-applied.
   */
  async bulkUpsert(dto: BulkBusRouteStopsDto): Promise<{
    routeId: string;
    createdStops: number;
    appended: boolean;
  }> {
    // Validate every placeId up-front before any writes — a missing Place
    // anywhere in the list should abort the whole call. Same placeId can
    // appear multiple times (loops); resolve to a map for O(1) lookup.
    const placeIds = dto.stops.map((s) => new Types.ObjectId(s.placeId));
    const uniqueIds = [
      ...new Map(placeIds.map((id) => [id.toString(), id])).values(),
    ];
    const places = await this.placeModel
      .find({ _id: { $in: uniqueIds } })
      .select('location')
      .lean()
      .exec();
    const placeById = new Map<string, { location: { coordinates: LngLat } }>(
      places.map((p) => [
        p._id.toString(),
        p as unknown as { location: { coordinates: LngLat } },
      ]),
    );
    for (const id of uniqueIds) {
      if (!placeById.has(id.toString())) {
        throw new BadRequestException(`Place ${id.toString()} not found`);
      }
    }

    const createdStopIds: Types.ObjectId[] = [];
    let createdRouteId: Types.ObjectId | null = null;

    let routeId: Types.ObjectId;
    let startOrder: number;
    let prevCoords: LngLat | null = null;
    let prevSegmentEnd: LngLat | null = null;
    const appending = Boolean(dto.routeId);

    if (dto.routeId) {
      routeId = new Types.ObjectId(dto.routeId);
      const route = await this.busRouteModel.findById(routeId).exec();
      if (!route) throw new NotFoundException(`Route ${dto.routeId} not found`);

      // Anchor the first new stop's segment at the existing tail of the route.
      const last = await this.busRouteStopModel
        .findOne({ route: routeId })
        .sort({ stopOrder: -1 })
        .populate<{
          stop: { location: { coordinates: LngLat } };
        }>('stop', 'location')
        .exec();

      if (last) {
        startOrder = (last.stopOrder ?? 0) + 1;
        prevCoords = this.populatedCoords(
          last,
          `Route tail stop (stopOrder ${last.stopOrder ?? '?'})`,
        );
        prevSegmentEnd = lastVertex(last.segmentPath);
      } else {
        startOrder = 1;
      }
    } else {
      const route = await this.busRouteModel.create({
        name: dto.name ?? null,
        code: dto.code ?? null,
        isLine: dto.isLine ?? false,
        direction: dto.direction ?? null,
      });
      routeId = route._id;
      createdRouteId = route._id;
      startOrder = 1;
    }

    try {
      for (let i = 0; i < dto.stops.length; i++) {
        const item = dto.stops[i];
        const place = placeById.get(item.placeId)!;
        const coords: LngLat = place.location.coordinates;
        const stopOrder = startOrder + i;
        let segmentPath: GeoJsonLineString | undefined;
        let distanceFromPrevious: number | null = null;

        if (!prevCoords) {
          // First stop of a brand-new route: no incoming segment.
          if (item.segmentFromPrevious || (item.vias && item.vias.length)) {
            throw new BadRequestException(
              `First stop (stopOrder ${stopOrder}) must not include segmentFromPrevious or vias`,
            );
          }
        } else {
          let pathCoords =
            item.segmentFromPrevious && item.segmentFromPrevious.length >= 2
              ? (item.segmentFromPrevious as LngLat[])
              : await this.buildRoadSegment(
                  prevCoords,
                  coords,
                  (item.vias ?? []) as LngLat[],
                );
          pathCoords = await this.stitchToPrevious(prevSegmentEnd, pathCoords);

          segmentPath = { type: 'LineString', coordinates: pathCoords };
          distanceFromPrevious = polylineLengthMeters(pathCoords);
          prevSegmentEnd = pathCoords[pathCoords.length - 1];
        }

        const routeStop = await this.busRouteStopModel.create({
          route: routeId,
          stop: new Types.ObjectId(item.placeId),
          stopOrder,
          segmentPath,
          distanceFromPrevious,
        });
        createdStopIds.push(routeStop._id);

        prevCoords = coords;
      }

      return {
        routeId: routeId.toString(),
        createdStops: createdStopIds.length,
        appended: appending,
      };
    } catch (err) {
      if (createdStopIds.length > 0) {
        await this.busRouteStopModel
          .deleteMany({ _id: { $in: createdStopIds } })
          .exec();
      }
      if (createdRouteId) {
        await this.busRouteModel.findByIdAndDelete(createdRouteId).exec();
      }
      throw err;
    }
  }
}
