import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
   * Polyline coordinates from the PREVIOUS stop to this one, drawn manually
   * on the frontend. Each entry is `[longitude, latitude]`. The first vertex
   * should match the previous stop's coords; the last vertex should match
   * this stop's coords.
   *
   * Required for every stop after the first; the service rejects requests
   * that omit it on stopOrder >= 2 or include it on stopOrder = 1.
   */
  @IsOptional()
  @IsArray()
  segmentFromPrevious?: [number, number][];
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

  // ─── The ordered list of stops to insert ───────────────────────────────────

  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => BulkRouteStopItemDto)
  stops!: BulkRouteStopItemDto[];
}
