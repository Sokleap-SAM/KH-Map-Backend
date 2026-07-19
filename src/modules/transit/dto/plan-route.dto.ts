/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Transform } from 'class-transformer';
import { IsEnum, IsNumber, IsNotEmpty, IsOptional, Min, Max } from 'class-validator';

export enum RouteType {
  WALK = 'walk',
  TRANSIT = 'transit',
}

export class PlanRouteDto {
  @Transform(({ value }) => parseFloat(value))
  @IsNumber()
  @IsNotEmpty()
  @Min(-180)
  @Max(180)
  originLng!: number;

  @Transform(({ value }) => parseFloat(value))
  @IsNumber()
  @IsNotEmpty()
  @Min(-90)
  @Max(90)
  originLat!: number;

  @Transform(({ value }) => parseFloat(value))
  @IsNumber()
  @IsNotEmpty()
  @Min(-180)
  @Max(180)
  destLng!: number;

  @Transform(({ value }) => parseFloat(value))
  @IsNumber()
  @IsNotEmpty()
  @Min(-90)
  @Max(90)
  destLat!: number;

  @IsOptional()
  @IsEnum(RouteType)
  type?: RouteType = RouteType.TRANSIT;
}
