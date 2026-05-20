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
   * Middle waypoints only — [longitude, latitude] pairs tracing the road between
   * the previous stop and this stop. Do NOT include the start or end coordinates;
   * the backend auto-prepends the previous stop's location and auto-appends this
   * stop's location. Omit entirely for a straight line between the two stops.
   *
   * Example: [[104.919, 11.570], [104.921, 11.573]]
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
}
