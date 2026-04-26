/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Transform, Type, plainToInstance } from 'class-transformer';
import { Types } from 'mongoose';

class GeoJsonPointDto {
  @IsString()
  @IsNotEmpty()
  type: 'Point';

  @Transform(({ value }) => (Array.isArray(value) ? value.map(Number) : value))
  @IsArray()
  @IsNumber({}, { each: true })
  coordinates: [number, number];
}

export class CreatePlaceDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @Transform(({ value }) =>
    value ? new Types.ObjectId(value as string) : null,
  )
  category?: Types.ObjectId | null;

  @ValidateNested()
  @Type(() => GeoJsonPointDto)
  @Transform(({ value }) => {
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        try {
          parsed = JSON.parse(value.replace(/'/g, '"'));
        } catch {
          return value;
        }
      }
    }
    return plainToInstance(GeoJsonPointDto, parsed);
  })
  location: GeoJsonPointDto;
}
