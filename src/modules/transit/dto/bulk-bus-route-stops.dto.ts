import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class BulkRouteStopItemDto {
  /**
   * Reference to an existing Place document. Places are managed via the
   * `/places` endpoints; the route-creator never mints new ones. The same
   * `placeId` may appear at multiple stopOrder positions on the same route
   * (loops re-visit the same stop).
   */
  @IsMongoId()
  placeId!: string;

  /**
   * Polyline coordinates from the PREVIOUS stop to this one, stored
   * verbatim — send `/admin/suggest-path` output after admin approval.
   * Each entry is `[longitude, latitude]`. Must NOT include the raw stop
   * coordinates: stops sit on the sidewalk, the path lives on the road.
   *
   * OPTIONAL for stops after the first — when omitted the backend computes
   * the road path itself via Valhalla (optionally steered by `vias`).
   * Must be absent on the first stop of a new route (no incoming segment).
   */
  @IsOptional()
  @IsArray()
  segmentFromPrevious?: [number, number][];

  /**
   * Optional steering points for the backend's Valhalla call — the segment
   * is forced through each via, road-snapped. Ignored when
   * `segmentFromPrevious` is provided.
   */
  @IsOptional()
  @IsArray()
  vias?: [number, number][];
}

export class BulkBusRouteStopsDto {
  /**
   * If provided, append to this route's existing stops. If omitted, a new
   * BusRoute is created from the route metadata fields below.
   */
  @IsOptional()
  @IsMongoId()
  routeId?: string;

  // ─── Used only when routeId is omitted (creating a new route) ──────────────

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsBoolean()
  isLine?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(['outbound', 'inbound'])
  direction?: 'outbound' | 'inbound';

  // ─── The ordered list of stops to insert ───────────────────────────────────

  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => BulkRouteStopItemDto)
  stops!: BulkRouteStopItemDto[];
}
