import { IsArray, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { Types } from 'mongoose';

export class CreateBusRouteStopDto {
  @IsNotEmpty()
  @Transform(({ value }) => new Types.ObjectId(value as string))
  route!: Types.ObjectId;

  @IsNotEmpty()
  @Transform(({ value }) => new Types.ObjectId(value as string))
  stop!: Types.ObjectId;

  @Transform(({ value }) => Number(value))
  @IsNumber()
  stopOrder!: number;

  @IsOptional()
  @Transform(({ value }) => (value != null ? Number(value) : undefined))
  @IsNumber()
  distanceFromPrevious?: number;

  /**
   * FULL polyline from the previous stop to this one, stored verbatim —
   * [longitude, latitude] pairs. Send the output of `/admin/suggest-path`
   * (optionally steered with vias) after the admin approves it. The raw
   * stop coordinates must NOT be included: stops sit on the sidewalk, the
   * path lives on the road.
   *
   * Omit to let the backend compute the road path via Valhalla itself
   * (optionally through `vias`).
   */
  @IsOptional()
  @IsArray()
  @IsArray({ each: true })
  @Transform(({ value }) => {
    if (value == null) return undefined;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as [number, number][];
      } catch {
        return value;
      }
    }
    return value as [number, number][];
  })
  waypoints?: [number, number][];

  /**
   * Optional steering points for the backend's Valhalla call — the path is
   * forced through each via, road-snapped. Ignored when `waypoints` is
   * provided (the polyline already encodes the admin's choice).
   */
  @IsOptional()
  @IsArray()
  @IsArray({ each: true })
  @Transform(({ value }) => {
    if (value == null) return undefined;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as [number, number][];
      } catch {
        return value;
      }
    }
    return value as [number, number][];
  })
  vias?: [number, number][];
}
