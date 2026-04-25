/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import {
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Transform, Type, plainToInstance } from 'class-transformer';

class GeoJsonPointDto {
  @IsString()
  type!: 'Point';

  @Transform(({ value }) => (Array.isArray(value) ? value.map(Number) : value))
  @IsNumber({}, { each: true })
  coordinates!: [number, number];
}

export class UpdateBusTripDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GeoJsonPointDto)
  @Transform(({ value }) => {
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        return value;
      }
    }
    return plainToInstance(GeoJsonPointDto, parsed);
  })
  currentLocation?: GeoJsonPointDto;

  @IsOptional()
  @Transform(({ value }) => (value != null ? Number(value) : undefined))
  @IsNumber()
  currentStopIndex?: number;

  @IsOptional()
  @Transform(({ value }) => (value != null ? Number(value) : undefined))
  @IsNumber()
  nextStopIndex?: number;

  @IsOptional()
  @Transform(({ value }) => (value != null ? Number(value) : undefined))
  @IsNumber()
  passengerCount?: number;
}
